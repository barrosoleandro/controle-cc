import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import type { Ctx } from '../App'
import type { Choice } from '../pages/Import'
import { categorize, merchantKey } from '../domain/categorize'
import { addCategory, type ImportPlan } from '../lib/data'
import { enrichVendors, loadMerchantProfiles, saveMerchantProfiles, type MerchantProfile, type VendorQuery } from '../lib/ai'
import type { CategoryKind, Currency } from '../domain/types'

const TIPO: Record<CategoryKind, string> = { expense: 'despesa', income: 'receita', transfer: 'transferência' }
const PADRAO = new Set(['Outros', 'Outras receitas'])
const MIN_CONF = 0.6 // below this the AI answer is shown but not pre-selected

interface Pendente {
  merchant: string
  linhas: number
  total: number
  exemplos: string[]
  currency: Currency
  debit: boolean
}

interface Props {
  ctx: Ctx
  plans: ImportPlan[]
  choices: Record<string, Choice>
  setChoices: Dispatch<SetStateAction<Record<string, Choice>>>
  busy: boolean
}

/**
 * Before anything is written: lists the merchants the rules cannot place, asks the AI
 * (merchant memory first, then the enrich-transactions function) and pre-selects its
 * category when confident. Everything stays editable; on import each chosen category
 * becomes a rule, so the rows are born categorized.
 */
export function ImportCategories({ ctx, plans, choices, setChoices, busy }: Props) {
  const { data } = ctx
  const [aiStatus, setAiStatus] = useState<string | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [criandoPara, setCriandoPara] = useState<string | null>(null)
  const [nome, setNome] = useState('')
  const [tipo, setTipo] = useState<CategoryKind>('expense')
  const [working, setWorking] = useState(false)

  const cats = useMemo(() => [...data.categories].sort((a, b) => a.name.localeCompare(b.name)), [data.categories])

  const pendentes = useMemo(() => {
    const bankByRef = new Map(data.accounts.map((a) => [a.external_ref, a.bank]))
    for (const p of plans) for (const h of p.result.accounts ?? []) if (!bankByRef.has(h.ref)) bankByRef.set(h.ref, h.bank)
    const grupos = new Map<string, Pendente>()
    for (const p of plans) {
      for (const t of p.result.transactions) {
        // Itaú usa 0000/00000-0 como número de conta; sem dica do arquivo, o resto é BCP.
        const bank = bankByRef.get(t.accountRef) ?? (t.accountRef.includes('/') ? 'ITAU' : 'BCP')
        if (!PADRAO.has(categorize(t, data.rules, data.bankMap, bank))) continue
        const key = merchantKey(t.description)
        if (key.length < 2) continue
        const g = grupos.get(key) ?? { merchant: key, linhas: 0, total: 0, exemplos: [], currency: t.currency, debit: t.amount < 0 }
        g.linhas++
        g.total += Math.abs(t.amount)
        if (g.exemplos.length < 4 && !g.exemplos.includes(t.description)) g.exemplos.push(t.description)
        grupos.set(key, g)
      }
    }
    return [...grupos.values()].sort((a, b) => b.total - a.total)
  }, [plans, data.rules, data.bankMap, data.accounts])

  const identify = useCallback(async (list: Pendente[], isCancelled: () => boolean) => {
    if (!list.length) return
    setAiError(null)
    const catById = new Map(data.categories.map((c) => [c.id, c]))
    const catByName = new Map(data.categories.map((c) => [c.name, c.id]))
    const fill = (entries: [string, Choice][]) =>
      setChoices((prev) => {
        const next = { ...prev }
        for (const [m, c] of entries) if (!next[m]) next[m] = c // never overwrite a hand-picked choice
        return next
      })
    try {
      // 1. Memory: merchants the AI (or the user) already described in earlier imports.
      setAiStatus('Consultando o histórico de estabelecimentos…')
      let profiles = new Map<string, MerchantProfile>()
      try { profiles = await loadMerchantProfiles() } catch { /* migration 003 not run yet */ }
      if (isCancelled()) return
      fill(list.flatMap((p) => {
        const pr = profiles.get(p.merchant)
        if (!pr?.suggested_category_id || !catById.has(pr.suggested_category_id)) return []
        if (!pr.accepted && (pr.confidence ?? 0) < MIN_CONF) return []
        return [[p.merchant, { categoryId: pr.suggested_category_id, description: pr.description, confidence: pr.confidence ?? undefined, source: pr.source }]]
      }))
      // 2. The rest goes to the AI.
      const ask = list.filter((p) => !profiles.has(p.merchant))
      if (!ask.length) { setAiStatus(null); return }
      const vendors: VendorQuery[] = ask.map((p) => ({
        merchant: p.merchant, samples: p.exemplos, sign: p.debit ? 'debit' : 'credit', currency: p.currency,
        typicalAmount: Math.round((p.total / p.linhas) * 100) / 100,
      }))
      const res = await enrichVendors(vendors, data.categories.map((c) => c.name),
        (done, total) => !isCancelled() && setAiStatus(`IA identificando estabelecimentos: ${done} de ${total}…`))
      if (isCancelled()) return
      try {
        await saveMerchantProfiles(res.map((s) => ({
          merchant: s.merchant, description: s.description, confidence: s.confidence, source: 'ai' as const,
          suggested_category_id: s.category ? catByName.get(s.category) ?? null : null,
        })))
      } catch { /* optional memory */ }
      const confident = res.filter((s) => s.category && catByName.has(s.category) && s.confidence >= MIN_CONF)
      fill(confident.map((s) => [s.merchant, { categoryId: catByName.get(s.category!)!, description: s.description, confidence: s.confidence, source: 'ai' }]))
      // Unsure answers still show what the merchant is, with no category pre-selected.
      fill(res.filter((s) => !confident.includes(s)).map((s) => [s.merchant, { categoryId: '', description: s.description, confidence: s.confidence, source: 'ai' }]))
      setAiStatus(`IA sugeriu categoria para ${confident.length} de ${ask.length} estabelecimentos novos. Confira antes de importar.`)
    } catch (e) {
      if (isCancelled()) return
      setAiStatus(null)
      setAiError(`IA indisponível (${(e as Error).message}). Defina as categorias à mão ou tente de novo.`)
    }
  }, [data.categories, setChoices])

  // Runs once per file selection (not on every rule/category reload).
  const planKey = plans.map((p) => p.sha256).join()
  useEffect(() => {
    let cancelled = false
    identify(pendentes, () => cancelled)
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey])

  async function criarCategoria(merchant: string) {
    const limpo = nome.trim()
    if (!limpo) return
    setWorking(true); setMsg(null)
    try {
      const repetida = data.categories.find((c) => c.name.toLowerCase() === limpo.toLowerCase())
      const criada = repetida ?? (await addCategory(limpo, tipo, '#888888', data.categories.length))
      setChoices((prev) => ({ ...prev, [merchant]: { ...prev[merchant], categoryId: criada.id, source: 'manual' } }))
      setCriandoPara(null); setNome('')
      await ctx.reload()
    } catch (e) { setMsg((e as Error).message) } finally { setWorking(false) }
  }

  if (!plans.length) return null
  if (!pendentes.length) {
    return <p className="pos">Tudo que vai entrar já cai numa categoria — nada para definir antes de importar.</p>
  }

  const definidos = pendentes.filter((p) => choices[p.merchant]?.categoryId).length
  const off = busy || working

  return (
    <div style={{ marginTop: 12 }}>
      <h4>Categorias antes de importar</h4>
      <p className="muted">
        {pendentes.length} estabelecimento(s) destes arquivos não casam com nenhuma regra. A IA recebe só o nome do estabelecimento
        e trechos da descrição (nunca o arquivo, o saldo ou a conta) e pré-seleciona a categoria quando tem confiança ≥ {MIN_CONF * 100}%.
        Ao importar, cada categoria escolhida vira regra. O que ficar em branco entra como “Outros”.
      </p>
      {aiStatus && <p className="muted">{aiStatus}</p>}
      {aiError && <p className="warn">{aiError} <button onClick={() => identify(pendentes.filter((p) => !choices[p.merchant]), () => false)} disabled={off}>Tentar de novo</button></p>}
      <p><strong>{definidos}</strong> de {pendentes.length} com categoria.</p>
      <div className="scroll"><table>
        <thead><tr><th>Estabelecimento</th><th className="hide-sm">O que é</th><th className="num">Linhas</th><th>Categoria</th><th className="num">IA</th></tr></thead>
        <tbody>{pendentes.map((p) => {
          const c = choices[p.merchant]
          return (
            <tr key={p.merchant}>
              <td><strong>{p.merchant}</strong><div className="muted" style={{ fontSize: 12 }}>{p.exemplos[0]}</div></td>
              <td className="hide-sm" style={{ fontSize: 13, maxWidth: 280 }}>{c?.description || <span className="muted">—</span>}</td>
              <td className="num">{p.linhas}</td>
              <td>
                {criandoPara === p.merchant ? (
                  <div className="row">
                    <input placeholder="Nome da categoria" value={nome} onChange={(e) => setNome(e.target.value)} disabled={off}
                      onKeyDown={(e) => { if (e.key === 'Enter') criarCategoria(p.merchant) }} />
                    <select value={tipo} onChange={(e) => setTipo(e.target.value as CategoryKind)} disabled={off}>
                      {(Object.keys(TIPO) as CategoryKind[]).map((k) => <option key={k} value={k}>{TIPO[k]}</option>)}
                    </select>
                    <button className="primary" onClick={() => criarCategoria(p.merchant)} disabled={off || !nome.trim()}>Criar</button>
                    <button onClick={() => setCriandoPara(null)} disabled={off}>Cancelar</button>
                  </div>
                ) : (
                  <div className="row">
                    <select value={c?.categoryId ?? ''} disabled={off} aria-label={`Categoria de ${p.merchant}`}
                      onChange={(e) => setChoices((prev) => ({ ...prev, [p.merchant]: { ...prev[p.merchant], categoryId: e.target.value, source: 'manual' } }))}>
                      <option value="">— Outros —</option>
                      {cats.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select>
                    <button onClick={() => { setCriandoPara(p.merchant); setNome(''); setMsg(null) }} disabled={off} aria-label={`Nova categoria para ${p.merchant}`}>+</button>
                  </div>
                )}
              </td>
              <td className={`num ${c?.confidence !== undefined && c.confidence < MIN_CONF ? 'warn' : ''}`}>
                {c?.source === 'manual' ? 'você' : c?.confidence !== undefined ? `${Math.round(c.confidence * 100)}%` : '—'}
              </td>
            </tr>
          )
        })}</tbody>
      </table></div>
      {msg && <p className="err">{msg}</p>}
    </div>
  )
}
