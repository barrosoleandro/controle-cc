import { useMemo, useState } from 'react'
import type { Ctx } from '../App'
import { enrichVendors, saveMerchantProfiles, vendorsToEnrich, type VendorSuggestion } from '../lib/ai'
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
 * Identifies merchants the rules could not place, using the enrich-transactions
 * Edge Function. Nothing is applied until the user accepts a row.
 */
export function AiSuggestions({ ctx }: { ctx: Ctx }) {
  const { data } = ctx
  const [rows, setRows] = useState<Row[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const pending = useMemo(() => vendorsToEnrich(data), [data])
  const catByName = useMemo(() => new Map(data.categories.map((c) => [c.name, c.id])), [data.categories])
  const sortedCats = useMemo(() => [...data.categories].sort((a, b) => a.name.localeCompare(b.name)), [data.categories])

  async function identify() {
    setBusy(true); setError(null); setMsg(null); setProgress('Consultando…')
    try {
      const suggestions = await enrichVendors(
        pending, data.categories.map((c) => c.name),
        (done, total) => setProgress(`${done} de ${total} estabelecimentos…`),
      )
      const byMerchant = new Map(pending.map((v) => [v.merchant, v]))
      const stats = new Map<string, { charges: number; total: number; currency: string }>()
      for (const t of data.transactions) {
        if (!byMerchant.has(t.merchant)) continue
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
      setProgress(null)
    } catch (e) { setError((e as Error).message); setProgress(null) } finally { setBusy(false) }
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
        Envia só a chave do estabelecimento e trechos da descrição do extrato — nunca o arquivo, o saldo ou o número da conta.
        A IA sugere uma categoria da <em>sua</em> lista e escreve o que o estabelecimento vende. Nada é aplicado sem você aceitar.
      </p>
      <div className="row">
        <button className="primary" onClick={identify} disabled={busy || !pending.length}>
          {pending.length ? `Identificar ${pending.length} estabelecimentos sem categoria` : 'Nada sem categoria'}
        </button>
        {progress && <span className="muted">{progress}</span>}
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
