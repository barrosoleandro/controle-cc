import { useMemo, useState } from 'react'
import type { Ctx } from '../App'
import { saveMerchantProfiles, vendorsToEnrich, type VendorSuggestion } from '../lib/ai'
import { buildExchangeRequest, parseExchangeAnswer } from '../domain/claudeExchange'
import { addRule, setCategoryForTransactions } from '../lib/data'
import { money } from '../lib/format'

interface Row extends VendorSuggestion {
  categoryId: string // resolved from the suggested name; '' when the model was unsure
  charges: number
  total: number
  currency: string
  use: boolean
}

/**
 * Identifies merchants the rules could not place with Claude, through a file exchange
 * (see domain/claudeExchange). Nothing is applied until the user accepts a row.
 */
export function AiSuggestions({ ctx }: { ctx: Ctx }) {
  const { data } = ctx
  const [rows, setRows] = useState<Row[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const pending = useMemo(() => vendorsToEnrich(data), [data])
  const catByName = useMemo(() => new Map(data.categories.map((c) => [c.name, c.id])), [data.categories])
  const sortedCats = useMemo(() => [...data.categories].sort((a, b) => a.name.localeCompare(b.name)), [data.categories])

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
      const suggestions = parseExchangeAnswer(await file.text(), data.categories.map((c) => c.name), pending.map((v) => v.merchant))
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
        const ids = data.transactions.filter((t) => t.merchant === r.merchant).map((t) => t.id)
        await setCategoryForTransactions(ids, r.categoryId)
        touched += ids.length
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
    <div className="card">
      <h3>Identificar com IA</h3>
      <p className="muted">
        1. Baixe o arquivo com os estabelecimentos sem categoria. Ele leva só a chave do estabelecimento e trechos da
        descrição do extrato, nunca o arquivo, o saldo ou o número da conta. 2. Peça ao Claude (Claude Code ou claude.ai)
        para categorizá-lo. 3. Importe o arquivo de resposta. O Claude escolhe só entre as <em>suas</em> categorias, e nada é
        aplicado sem você aceitar.
      </p>
      <div className="row">
        <button className="primary" onClick={exportForClaude} disabled={busy || !pending.length}>
          {pending.length ? `Baixar ${pending.length} estabelecimentos sem categoria` : 'Nada sem categoria'}
        </button>
        <label className="inline"><span className="muted">Importar resposta do Claude</span>
          <input type="file" accept=".json,application/json" disabled={busy}
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) importAnswer(f) }} /></label>
      </div>
      {error && <p className="err">{error}</p>}
      {msg && <p className="pos">{msg}</p>}

      {rows && rows.length > 0 && <>
        <div className="scroll"><table style={{ marginTop: 10 }}>
          <thead><tr><th>Usar</th><th>Estabelecimento</th><th>O que é</th><th>Categoria</th><th className="num">Conf.</th><th className="num hide-sm">Lanç.</th><th className="num hide-sm">Total</th></tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={r.merchant}>
              <td><input type="checkbox" checked={r.use} disabled={busy || !r.categoryId} aria-label={`Usar ${r.merchant}`}
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, use: e.target.checked } : x)))} /></td>
              <td>{r.merchant}</td>
              <td style={{ maxWidth: 320 }}>{r.description || <span className="muted">—</span>}</td>
              <td><select value={r.categoryId} disabled={busy}
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, categoryId: e.target.value, use: Boolean(e.target.value) } : x)))}>
                <option value="">— não tenho certeza —</option>
                {sortedCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></td>
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
