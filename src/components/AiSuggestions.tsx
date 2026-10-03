import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Ctx } from '../App'
import { saveMerchantProfiles, vendorsToEnrich, type VendorSuggestion } from '../lib/ai'
import { buildExchangeRequest, parseExchangeAnswer } from '../domain/claudeExchange'
import { parseVendorAnswer, VENDOR_BATCH, vendorPrompt } from '../domain/localAi'
import { ask, loadOllama, ollamaReady } from '../lib/ollama'
import { byName } from '../domain/categorize'
import { addCategory, addRule, markAiNote, setCategoryForTransactions } from '../lib/data'
import type { CategoryKind } from '../domain/types'
import { money } from '../lib/format'

const TIPO: Record<CategoryKind, string> = { expense: 'despesa', income: 'receita', transfer: 'transferência' }

interface Row extends VendorSuggestion {
  categoryId: string // resolved from the suggested name; '' when the model was unsure
  charges: number
  total: number
  currency: string
  use: boolean
}

/**
 * Identifies merchants the rules could not place. Two paths, same contract and same
 * validation (domain/claudeExchange): the local model through Ollama, which keeps
 * everything on this machine, or a file exchange with Claude. Nothing is applied
 * until the user accepts a row.
 */
export function AiSuggestions({ ctx }: { ctx: Ctx }) {
  const { data } = ctx
  const [rows, setRows] = useState<Row[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [criandoPara, setCriandoPara] = useState<string | null>(null)
  const [nome, setNome] = useState('')
  const [tipo, setTipo] = useState<CategoryKind>('expense')
  // Read on mount and again on focus, so turning it on in Ajustes shows up here.
  const [cfg, setCfg] = useState(loadOllama)
  useEffect(() => {
    const refresh = () => setCfg(loadOllama())
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [])

  const pending = useMemo(() => vendorsToEnrich(data), [data])
  const catByName = useMemo(() => new Map(data.categories.map((c) => [c.name, c.id])), [data.categories])
  const sortedCats = useMemo(() => [...data.categories].sort(byName), [data.categories])
  const localReady = ollamaReady(cfg)

  /** Turns suggestions into review rows and remembers the descriptions either way. */
  const showSuggestions = useCallback(async (suggestions: VendorSuggestion[]) => {
    const stats = new Map<string, { charges: number; total: number; currency: string }>()
    for (const t of data.transactions) {
      const s = stats.get(t.merchant) ?? { charges: 0, total: 0, currency: t.currency }
      s.charges++; s.total += Math.abs(Number(t.amount))
      stats.set(t.merchant, s)
    }
    setRows(suggestions.map((s) => {
      const st = stats.get(s.merchant)
      const categoryId = s.category ? catByName.get(s.category) ?? '' : ''
      return {
        ...s, categoryId,
        charges: st?.charges ?? 0, total: st?.total ?? 0, currency: st?.currency ?? 'EUR',
        use: Boolean(categoryId) && s.confidence >= 0.6,
      }
    }))
    // Keep the descriptions even if the user accepts nothing: the next import reuses them.
    await saveMerchantProfiles(suggestions.map((s) => ({
      merchant: s.merchant, description: s.description,
      suggested_category_id: s.category ? catByName.get(s.category) ?? null : null,
      confidence: s.confidence, source: 'ai' as const,
    })))
  }, [data.transactions, catByName])

  /**
   * Local model, in batches. A small model trips over long prompts and sometimes emits
   * broken JSON, so one bad batch is reported and the rest still count.
   */
  async function runLocal() {
    const c = loadOllama()
    setCfg(c)
    if (!ollamaReady(c)) { setError('Ative e configure o endereço e o modelo em Ajustes → IA local.'); return }
    setBusy(true); setError(null); setMsg(null)
    const names = data.categories.map((x) => x.name)
    const found: VendorSuggestion[] = []
    const falhas: string[] = []
    try {
      for (let i = 0; i < pending.length; i += VENDOR_BATCH) {
        const lote = pending.slice(i, i + VENDOR_BATCH)
        setProgress(`${c.model}: ${Math.min(i + lote.length, pending.length)} de ${pending.length} estabelecimentos…`)
        const { system, prompt } = vendorPrompt(lote, names)
        try {
          found.push(...parseVendorAnswer(await ask(c, prompt, { json: true, system }), names, lote.map((v) => v.merchant)))
        } catch (e) { falhas.push((e as Error).message) }
      }
      if (!found.length) throw new Error(falhas[0] ?? 'O modelo local não devolveu nenhuma sugestão utilizável.')
      await showSuggestions(found)
      setMsg(`${found.length} de ${pending.length} estabelecimentos identificados por ${c.model}, sem nada sair deste computador`
        + `${falhas.length ? ` · ${falhas.length} lote(s) falharam` : ''}. Nada foi aplicado ainda — confira abaixo.`)
      if (falhas.length) setError(`Lotes que falharam: ${[...new Set(falhas)].slice(0, 3).join(' · ')}`)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false); setProgress(null) }
  }

  function exportForClaude() {
    setError(null); setMsg(null)
    const request = buildExchangeRequest(pending, data.categories.map((c) => c.name))
    const url = URL.createObjectURL(new Blob([JSON.stringify(request, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url; a.download = `categorias-para-claude-${new Date().toISOString().slice(0, 10)}.json`; a.click()
    URL.revokeObjectURL(url)
    setMsg(`Arquivo com ${pending.length} estabelecimentos baixado. Peça ao Claude para categorizá-lo e importe a resposta aqui.`)
  }

  async function importAnswer(file: File) {
    setBusy(true); setError(null); setMsg(null)
    try {
      await showSuggestions(parseExchangeAnswer(await file.text(), data.categories.map((c) => c.name), pending.map((v) => v.merchant)))
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  /** Creates a category from a row (or reuses one with the same name) and selects it there. */
  async function criarCategoria(merchant: string) {
    const limpo = nome.trim()
    if (!limpo || !rows) return
    setBusy(true); setError(null)
    try {
      const repetida = data.categories.find((c) => c.name.toLowerCase() === limpo.toLowerCase())
      const criada = repetida ?? (await addCategory(limpo, tipo, '#888888', data.categories.length))
      setRows(rows.map((r) => (r.merchant === merchant ? { ...r, categoryId: criada.id, use: true } : r)))
      setCriandoPara(null); setNome('')
      await ctx.reload()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  async function apply() {
    if (!rows) return
    const chosen = rows.filter((r) => r.use && r.categoryId)
    if (!chosen.length) return
    setBusy(true); setError(null)
    try {
      let priority = Math.min(1000, ...data.rules.map((r) => r.priority)) - 1
      let touched = 0
      for (const r of chosen) {
        const txs = data.transactions.filter((t) => t.merchant === r.merchant)
        await setCategoryForTransactions(txs.map((t) => t.id), r.categoryId)
        await markAiNote(txs, true) // shows in Lançamentos until the category is changed by hand
        touched += txs.length
        // Same learning path as the rest of the app: a rule means the next import needs no AI.
        if (!data.rules.some((x) => x.pattern.toUpperCase() === r.merchant.toUpperCase())) {
          await addRule(r.merchant, r.categoryId, null, priority); priority--
        }
      }
      await saveMerchantProfiles(chosen.map((r) => ({
        merchant: r.merchant, description: r.description,
        suggested_category_id: r.categoryId, confidence: r.confidence, source: 'ai' as const,
      })), true)
      setMsg(`${chosen.length} estabelecimentos aplicados · ${touched} lançamentos categorizados · regras criadas para os próximos imports.`)
      setRows(rows.filter((r) => !chosen.includes(r)))
      await ctx.reload()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="card" style={{ gridColumn: '1/-1' }}>
      <h3>Identificar com IA</h3>
      <p className="muted">
        Só a chave do estabelecimento e trechos da descrição do extrato são usados — nunca o arquivo, o saldo ou o número
        da conta. Qualquer dos caminhos escolhe apenas entre as <em>suas</em> categorias, e nada é aplicado sem você aceitar.
      </p>

      <div className="row">
        <button className="primary" onClick={runLocal} disabled={busy || !pending.length || !localReady}
          title={!localReady ? 'Configure em Ajustes → IA local' : `Roda em ${cfg.model}, neste computador`}>
          {pending.length ? `Identificar ${pending.length} com a IA local` : 'Nada sem categoria'}
        </button>
        {localReady
          ? <span className="muted" style={{ fontSize: 12 }}>modelo local: {cfg.model}</span>
          : <span className="muted" style={{ fontSize: 12 }}>IA local desligada — ligue em Ajustes → IA local para não enviar nada para fora</span>}
      </div>
      {progress && <p className="muted">{progress} (um modelo local pode levar alguns minutos)</p>}

      <details style={{ marginTop: 8 }}>
        <summary className="muted">Ou fazer pelo Claude, por arquivo</summary>
        <p className="muted" style={{ fontSize: 13 }}>
          1. Baixe o arquivo com os estabelecimentos sem categoria. 2. Peça ao Claude (Claude Code ou claude.ai) para
          categorizá-lo. 3. Importe o arquivo de resposta aqui. Útil quando o modelo local errar muito.
        </p>
        <div className="row">
          <button onClick={exportForClaude} disabled={busy || !pending.length}>
            {pending.length ? `Baixar ${pending.length} estabelecimentos` : 'Nada sem categoria'}
          </button>
          <label className="inline"><span className="muted">Importar resposta do Claude</span>
            <input type="file" accept=".json,application/json" disabled={busy}
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) importAnswer(f) }} /></label>
        </div>
      </details>

      {error && <p className="err">{error}</p>}
      {msg && <p className="pos">{msg}</p>}

      {rows && rows.length > 0 && <>
        <div className="scroll"><table style={{ marginTop: 10 }}>
          <thead><tr><th>Usar</th><th>Estabelecimento</th><th>Categoria</th><th className="num">Conf.</th><th className="num hide-sm">Lanç.</th><th className="num hide-sm">Total</th></tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={r.merchant}>
              <td><input type="checkbox" checked={r.use} disabled={busy || !r.categoryId} aria-label={`Usar ${r.merchant}`}
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, use: e.target.checked } : x)))} /></td>
              <td><strong>{r.merchant}</strong><div className="muted" style={{ fontSize: 12 }}>{r.description}</div></td>
              <td style={{ minWidth: 200 }}>
                {criandoPara === r.merchant ? (
                  <div className="row" style={{ marginBottom: 0 }}>
                    <input placeholder="Nome da categoria" value={nome} onChange={(e) => setNome(e.target.value)} disabled={busy} autoFocus
                      onKeyDown={(e) => { if (e.key === 'Enter') criarCategoria(r.merchant) }} />
                    <select value={tipo} onChange={(e) => setTipo(e.target.value as CategoryKind)} disabled={busy}>
                      {(Object.keys(TIPO) as CategoryKind[]).map((k) => <option key={k} value={k}>{TIPO[k]}</option>)}
                    </select>
                    <button className="primary" onClick={() => criarCategoria(r.merchant)} disabled={busy || !nome.trim()}>Criar</button>
                    <button onClick={() => setCriandoPara(null)} disabled={busy}>Cancelar</button>
                  </div>
                ) : (
                  <div className="row" style={{ marginBottom: 0, flexWrap: 'nowrap' }}>
                    <select value={r.categoryId} disabled={busy} style={{ minWidth: 160 }} aria-label={`Categoria de ${r.merchant}`}
                      onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, categoryId: e.target.value, use: Boolean(e.target.value) } : x)))}>
                      <option value="">— não tenho certeza —</option>
                      {sortedCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    <button onClick={() => { setCriandoPara(r.merchant); setNome(''); setTipo('expense') }} disabled={busy}
                      title="Criar nova categoria" aria-label={`Nova categoria para ${r.merchant}`}>+</button>
                  </div>
                )}
              </td>
              <td className={`num ${r.confidence < 0.6 ? 'warn' : ''}`}>{Math.round(r.confidence * 100)}%</td>
              <td className="num hide-sm">{r.charges}</td>
              <td className="num hide-sm">{money(r.currency as 'EUR' | 'BRL', 0)(r.total)}</td>
            </tr>
          ))}</tbody>
        </table></div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="primary" onClick={apply} disabled={busy || !rows.some((r) => r.use)}>
            Aplicar {rows.filter((r) => r.use).length} selecionados
          </button>
          <button onClick={() => setRows(null)} disabled={busy}>Descartar</button>
        </div>
        <p className="muted">Linhas com confiança abaixo de 60% vêm desmarcadas de propósito — confira antes de aceitar.</p>
      </>}
      {rows && rows.length === 0 && <p className="muted">Todas as sugestões foram tratadas.</p>}
    </div>
  )
}
