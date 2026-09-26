import { useMemo, useState } from 'react'
import type { Ctx } from '../App'
import { suggestRules, type RuleSuggestion } from '../domain/learn'
import { addRule, reapplyRules } from '../lib/data'

/**
 * Regras deduzidas das categorias que você já escolheu à mão, para o próximo
 * import repetir essas escolhas em vez de cair em "Outros".
 */
export function LearnedRules({ ctx }: { ctx: Ctx }) {
  const { data } = ctx
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [ignorados, setIgnorados] = useState<string[]>([])

  const suggestions = useMemo(() => {
    const bankOf = new Map(data.accounts.map((a) => [a.id, a.bank]))
    const nameOf = new Map(data.categories.map((c) => [c.id, c.name]))
    return suggestRules(
      data.transactions.map((t) => ({
        description: t.description, amount: t.amount, bankCategory: t.bank_category, bankSubcategory: t.bank_subcategory,
        merchant: t.merchant, bank: bankOf.get(t.account_id) ?? 'BCP',
        categoryId: t.category_id, categoryLocked: t.category_locked,
      })),
      data.rules, data.bankMap, (id) => nameOf.get(id),
    )
  }, [data])

  const shown = suggestions.filter((s) => !ignorados.includes(s.pattern))

  async function aprender(list: RuleSuggestion[]) {
    if (!list.length) return
    setBusy(true); setMsg(null)
    try {
      // Menor número de prioridade vence, então o aprendido bate as regras padrão.
      let priority = Math.min(1000, ...data.rules.map((r) => r.priority)) - 1
      for (const s of list) { await addRule(s.pattern, s.categoryId, null, priority); priority-- }
      const extra = list.map((s) => ({ id: `learn:${s.pattern}`, pattern: s.pattern, category: s.categoryName, category_id: s.categoryId, priority: 0 }))
      const n = await reapplyRules({ ...data, rules: [...extra, ...data.rules] })
      setMsg(`${list.length} regra(s) aprendida(s) · ${n} lançamentos antigos recategorizados. Os próximos imports já aplicam isso sozinhos.`)
      await ctx.reload()
    } catch (e) { setMsg((e as Error).message) } finally { setBusy(false) }
  }

  if (!shown.length) {
    return <div className="card"><h3>Aprendizado pelo histórico</h3>
      <p className="muted">Nada novo para aprender: todo estabelecimento que você categorizou à mão já tem regra. Defina a categoria de um recorrente ou de um lançamento e a sugestão aparece aqui.</p>
      {msg && <p className="pos">{msg}</p>}
    </div>
  }

  return (
    <div className="card">
      <h3>Aprendizado pelo histórico</h3>
      <p className="muted">
        {shown.length} estabelecimento(s) que você categorizou à mão e que as regras atuais ainda erram.
        Ensinar agora significa que o próximo import já cai na categoria certa.
      </p>
      <div className="row"><button className="primary" onClick={() => aprender(shown)} disabled={busy}>Aprender todos ({shown.length})</button></div>
      <div className="scroll"><table>
        <thead><tr><th>Estabelecimento</th><th>Categoria</th><th className="num">Lanç.</th><th className="num">Concordância</th><th className="num">Corrige</th><th /></tr></thead>
        <tbody>{shown.map((s) => (
          <tr key={s.pattern}>
            <td>{s.pattern}</td>
            <td>{s.categoryName}</td>
            <td className="num">{s.total}</td>
            <td className="num">{Math.round(s.confidence * 100)}%</td>
            <td className="num">{s.wouldFix}</td>
            <td style={{ whiteSpace: 'nowrap' }}>
              <button onClick={() => aprender([s])} disabled={busy}>Aprender</button>{' '}
              <button onClick={() => setIgnorados([...ignorados, s.pattern])} disabled={busy} aria-label={`Ignorar ${s.pattern}`}>✕</button>
            </td>
          </tr>
        ))}</tbody>
      </table></div>
      {msg && <p className="pos">{msg}</p>}
      <p className="muted">Concordância = quanto dos lançamentos desse estabelecimento já está nessa categoria. Corrige = quantos as regras atuais colocariam em outro lugar.</p>
    </div>
  )
}
