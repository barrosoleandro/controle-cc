import { Fragment, useMemo, useState } from 'react'
import type { Ctx } from '../App'
import { billPayment, futureInstalments, matchCardPayments } from '../domain/cards'
import { linkCardPayments, loadAll, updateAccount } from '../lib/data'
import { money } from '../lib/format'

const dateBR = (iso: string) => iso.split('-').reverse().join('/')

interface Bill { due: string; status: 'paga' | 'aberta' | 'sem fatura'; total: number | null; spent: number; paidOn?: string; debitFound?: boolean }

/**
 * Credit cards linked to the account that pays them, in three equal columns: the bills
 * (faturas) with their payment; the selected bill by category and line by line; and an
 * estimate of the next 6 bills from the instalment purchases already billed.
 */
export function Cards({ ctx }: { ctx: Ctx }) {
  const { data } = ctx
  const cards = data.accounts.filter((a) => a.type === 'card')
  const payers = data.accounts.filter((a) => a.type !== 'card')
  const [cardId, setCardId] = useState(cards[0]?.id ?? '')
  const [due, setDue] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [catFilter, setCatFilter] = useState<string | null>(null) // category picked in the selected bill
  const [openFuture, setOpenFuture] = useState<string | null>(null) // future bill whose parcelas are shown
  const card = cards.find((c) => c.id === cardId) ?? cards[0]

  const catById = useMemo(() => new Map(data.categories.map((c) => [c.id, c])), [data.categories])
  const rows = useMemo(() => (card ? data.transactions.filter((t) => t.account_id === card.id) : []), [data.transactions, card])
  const isTransfer = (categoryId: string | null) => (categoryId ? catById.get(categoryId)?.kind === 'transfer' : false)

  const bills: Bill[] = useMemo(() => {
    if (!card) return []
    const matched = new Set(matchCardPayments(data.accounts, data.transactions).map((m) => m.cardTx.id))
    const map = new Map<string, Bill>()
    for (const s of data.cardStatements.filter((x) => x.account_id === card.id)) {
      const p = billPayment(s, rows)
      map.set(s.due_date, { due: s.due_date, status: s.status, total: s.total, spent: 0, paidOn: p?.booking_date, debitFound: p ? matched.has(p.id) : undefined })
    }
    for (const t of rows) {
      if (!t.statement_due || isTransfer(t.category_id)) continue
      const b = map.get(t.statement_due) ?? { due: t.statement_due, status: 'sem fatura' as const, total: null, spent: 0 }
      b.spent -= Number(t.amount)
      map.set(t.statement_due, b)
    }
    return [...map.values()].sort((a, b) => b.due.localeCompare(a.due))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card, rows, data.cardStatements, data.accounts, data.transactions, catById])

  const selected = bills.find((b) => b.due === due) ?? bills.find((b) => b.status === 'aberta') ?? bills[0]

  const breakdown = useMemo(() => {
    if (!selected) return { byCat: [], byMerchant: [], total: 0, lines: [] }
    const inBill = rows.filter((t) => t.statement_due === selected.due && !isTransfer(t.category_id))
    const sum = (key: (t: (typeof inBill)[number]) => string) => {
      const m = new Map<string, { value: number; n: number }>()
      for (const t of inBill) { const k = key(t); const g = m.get(k) ?? { value: 0, n: 0 }; g.value -= Number(t.amount); g.n++; m.set(k, g) }
      return [...m].map(([name, g]) => ({ name, ...g })).sort((a, b) => b.value - a.value)
    }
    return {
      byCat: sum((t) => (t.category_id ? catById.get(t.category_id)?.name ?? '?' : 'Sem categoria')),
      byMerchant: sum((t) => t.merchant || t.description).slice(0, 12),
      total: inBill.reduce((s, t) => s - Number(t.amount), 0),
      lines: inBill.map((t) => ({ ...t, cat: t.category_id ? catById.get(t.category_id)?.name ?? '?' : 'Sem categoria' }))
        .sort((a, b) => b.booking_date.localeCompare(a.booking_date) || Number(a.amount) - Number(b.amount)),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, selected, catById])

  const future = useMemo(() => futureInstalments(rows, 6), [rows])

  async function link(parentId: string) {
    if (!card) return
    setBusy(true); setMsg(null)
    try {
      await updateAccount(card.id, { parent_account_id: parentId || null })
      const n = parentId ? await linkCardPayments(await loadAll()) : 0
      setMsg(n ? `${n} pagamento(s) de fatura na conta vinculada marcados como transferência.` : 'Vínculo salvo.')
      await ctx.reload()
    } catch (e) { setMsg((e as Error).message) } finally { setBusy(false) }
  }

  if (!card) {
    return <div className="card"><h3>Cartões</h3>
      <p className="muted">Nenhum cartão ainda. Importe a fatura do cartão Itaú em Excel (.xlsx) na aba Importar — o cartão é criado e vinculado à conta Itaú automaticamente.</p>
    </div>
  }

  const f = money(card.currency, 2)
  const f0 = money(card.currency, 0)
  const parent = payers.find((p) => p.id === card.parent_account_id)

  return (
    <div className="grid">
      <div className="card" style={{ gridColumn: '1/-1' }}>
        <div className="row">
          {cards.length > 1 && <select value={card.id} onChange={(e) => { setCardId(e.target.value); setDue('') }} aria-label="Cartão">
            {cards.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>}
          <h3 style={{ margin: 0 }}>{card.name}</h3>
          <label className="inline">Paga pela conta
            <select value={card.parent_account_id ?? ''} disabled={busy} onChange={(e) => link(e.target.value)}>
              <option value="">— não vinculado —</option>
              {payers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        </div>
        <p className="muted">
          As compras entram como despesa no cartão. Cada pagamento que aparece numa fatura importada é casado com o débito em
          {' '}{parent?.name ?? 'a conta vinculada'} (mesmo valor, até 5 dias), que vira transferência — assim nada é contado duas vezes.
          Pagamentos de faturas não importadas continuam como “Cartão Itaú”.
        </p>
        {!card.parent_account_id && <p className="warn">Vincule a conta que paga este cartão para evitar contar a fatura duas vezes.</p>}
        {msg && <p className="pos">{msg}</p>}
      </div>

      <div className="cards3">
        {/* 1 — Bills */}
        <div className="card col">
          <h3>Faturas</h3>
          <div className="col-scroll"><table className="tight">
            <thead><tr><th>Vencimento</th><th>Situação</th><th className="num">Total</th><th title="Pagamento na conta vinculada">Pgto.</th></tr></thead>
            <tbody>{bills.map((b) => (
              <tr key={b.due} className={`clickable ${b.due === selected?.due ? 'sel' : ''}`} onClick={() => { setDue(b.due); setCatFilter(null) }}
                aria-selected={b.due === selected?.due}>
                <td>{dateBR(b.due)}</td>
                <td><span className={`badge ${b.status === 'aberta' ? 'b-open' : b.status === 'paga' ? 'b-paid' : ''}`}>{b.status}</span></td>
                <td className="num">{f(b.total ?? b.spent)}</td>
                <td title={!b.paidOn ? 'Sem pagamento na fatura' : b.debitFound ? `Pago em ${dateBR(b.paidOn)}: débito achado na conta` : `Pago em ${dateBR(b.paidOn)}: débito não achado na conta`}
                  className={b.paidOn && !b.debitFound ? 'warn' : 'pos'}>{!b.paidOn ? '—' : b.debitFound ? '✓' : '⚠'}</td>
              </tr>
            ))}</tbody>
          </table></div>
          <p className="muted" style={{ fontSize: 12 }}>Clique numa fatura para ver o detalhe. ⚠ = pagamento sem o débito na conta (extrato não importado ou conta não vinculada).</p>
        </div>

        {/* 2 — Selected bill: by category, then line by line */}
        <div className="card col">
          {selected ? <>
            <h3>Fatura {dateBR(selected.due)}</h3>
            <div className="kpis">
              <div className="kpi"><div className="l">Compras</div><div className="v">{f0(breakdown.total)}</div></div>
              <div className="kpi"><div className="l">Lançamentos</div><div className="v">{breakdown.lines.length}</div></div>
            </div>
            <h4 className="sub">Por categoria {catFilter && <button className="link" onClick={() => setCatFilter(null)}>mostrar todas</button>}</h4>
            <table className="tight"><tbody>{breakdown.byCat.map((c) => (
              <tr key={c.name} className={`clickable ${catFilter === c.name ? 'sel' : ''}`} onClick={() => setCatFilter(catFilter === c.name ? null : c.name)}>
                <td>{c.name}</td>
                <td style={{ width: '34%' }}><div className="bar"><div style={{ width: `${breakdown.total > 0 ? Math.max(0, (c.value / breakdown.total) * 100) : 0}%` }} /></div></td>
                <td className="num">{f0(c.value)}</td>
                <td className="num muted">{breakdown.total > 0 ? Math.round((c.value / breakdown.total) * 100) : 0}%</td>
              </tr>
            ))}</tbody></table>
            <h4 className="sub">Lançamentos{catFilter ? ` · ${catFilter}` : ''}</h4>
            <div className="col-scroll short"><table className="tight">
              <tbody>{breakdown.lines.filter((t) => !catFilter || t.cat === catFilter).map((t) => (
                <tr key={t.id}>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>{dateBR(t.booking_date).slice(0, 5)}</td>
                  <td>{t.description}<div className="muted" style={{ fontSize: 12 }}>{t.cat}</div></td>
                  <td className={`num ${Number(t.amount) > 0 ? 'pos' : ''}`}>{f(-Number(t.amount))}</td>
                </tr>
              ))}</tbody>
            </table></div>
            {breakdown.byCat.some((c) => c.name === 'Outros' || c.name === 'Sem categoria') &&
              <p className="muted" style={{ fontSize: 12 }}>Há compras em “Outros”: use Importar → Identificar com IA ou Lançamentos para categorizar.</p>}
          </> : <p className="muted">Nenhuma fatura.</p>}
        </div>

        {/* 3 — Next 6 bills: instalments already committed */}
        <div className="card col">
          <h3>Próximas 6 faturas · parcelas</h3>
          {future.every((b) => !b.parcels.length) ? <p className="muted">Nenhuma compra parcelada em aberto nas faturas importadas.</p> : (
            <table className="tight"><tbody>{future.map((b) => (
              <Fragment key={b.due}>
                <tr className={`clickable ${openFuture === b.due ? 'sel' : ''}`} onClick={() => setOpenFuture(openFuture === b.due ? null : b.due)} aria-expanded={openFuture === b.due}>
                  <td>{openFuture === b.due ? '▾' : '▸'} {dateBR(b.due)}</td>
                  <td className="muted">{b.parcels.length} parcela(s)</td>
                  <td className="num"><strong>{f(b.total)}</strong></td>
                </tr>
                {openFuture === b.due && b.parcels.map((pc, i) => (
                  <tr key={i} className="nested">
                    <td colSpan={2}>{pc.purchase} <span className="muted">{pc.k}/{pc.n}</span></td>
                    <td className="num">{f(pc.amount)}</td>
                  </tr>
                ))}
              </Fragment>
            ))}</tbody></table>
          )}
          <p className="muted" style={{ fontSize: 12 }}>
            Estimativa a partir das parcelas já lançadas nas faturas importadas (a última é {bills[0] ? dateBR(bills[0].due) : '—'}):
            cada compra parcelada continua com o mesmo valor até a última parcela. Compras novas ainda não entram.
          </p>
        </div>
      </div>
    </div>
  )
}
