/**
 * Simulation workbook of Lançamentos: one block per account, one under the other, with the same
 * months as columns (as many back as chosen, the current one, 2 ahead). Rows are category subtotals
 * (formulas) over merchant rows (values); rows with no value in the period are left out. Changing
 * any value in Excel flows into the totals and the month-to-month balance. Values are in the
 * account's own currency: income positive, expenses and money sent negative.
 *
 * Salary (optional category name): paid at the end of the month before the one it is for, it is
 * shown in the month it is for, so each month has its own salary. The balances follow: a month's
 * closing leaves out the next month's salary already credited, unlike the bank's.
 *
 * Current month: what came in plus the recurring lines not in yet. Future months: the same,
 * plus "(demais, média 3 meses)" per category, so a category is at least its 3-month average.
 *
 * Brazil (optional): in the Itaú account the card shows only as its bill total, projected for the
 * months not paid yet; and while no money arrived from abroad in a month, the transfer from the
 * sending account is estimated with the Painel alert rule — bill + recurring bills − opening
 * balance, rounded up to 10 — as a formula, mirrored in the sender through the exchange-rate cell.
 */
import type { Cell } from 'write-excel-file/browser'
import { nextMonth, recurringExpectations, steadyIncomes, type PlanTx } from './monthPlan'
import { isCardBillPayment, sentToBrazil } from './forecast'

export type Kind = 'income' | 'expense' | 'transfer'
export interface SimTx { account_id: string; month: string; amount: number; kind: Kind; categoryName: string; merchant: string; booking_date: string; description?: string; bank_category?: string | null }
export interface SimAccount { id: string; name: string; currency: string; opening: number } // opening: balance before the first month
/** Recurring flag; `steady`: the account's incomes that came in every average month (recurring unless unmarked). */
export type IsRecurring = (merchant: string, kind: 'income' | 'expense', steady: Set<string>) => boolean
/** `to`: the Itaú checking account; `from`: the account that sends; `rate`: BRL per 1 unit of the sender's currency; `bill`: projected card bill of a month (0 = unknown). */
export interface BrazilLink { from: string; to: string; rate: number; bill: (month: string) => number }

export type { Cell }
export const OTHERS = '(demais, média 3 meses)'
export const BILL = 'Fatura do cartão Itaú'
const SALARY_FROM_DAY = 20 // a salary credited from this day on is the next month's
export const SENT = 'Transferência para o Itaú (estimada)'
export const RECEIVED = 'Transferência do exterior (estimada)'
const NUM = '#,##0.00;[Red]-#,##0.00'
const PROJ = '#FFF4D6' // background of the months that are (partly) projected
const SECTIONS: [Kind, string][] = [['income', 'Receitas'], ['expense', 'Despesas'], ['transfer', 'Transferências']]
const RATE_ROW = 2 // the exchange rate sits in C2

/** Excel column name of a 1-based column number: 1 → A, 27 → AA. */
const colName = (n: number): string => (n > 26 ? colName(Math.floor((n - 1) / 26)) : '') + String.fromCharCode(65 + ((n - 1) % 26))
const col = (i: number) => colName(i + 3) // month i → C, D, … (any number of months)
/** A merchant row is shown only when it has a value in the period; the estimated transfers always are. */
const keep = (m: string, v: number[]) => m === SENT || m === RECEIVED || v.some((x) => Math.abs(x) > 0.005)
const round = (v: number) => Math.round(v * 100) / 100
/** Sign that makes a value positive for its kind: income counts up, the rest counts down. */
const mag = (kind: Kind, v: number) => (kind === 'income' ? v : -v)

export function buildSimSheet(accounts: SimAccount[], txs: SimTx[], months: string[], current: string, avgMonths: string[], isRecurring: IsRecurring, labels: (m: string) => string, brazil?: BrazilLink, salary?: string): Cell[][] {
  const cur = months.indexOf(current)
  const ahead = (i: number) => cur >= 0 && i >= cur // current month and after: (partly) projected
  const link = brazil && accounts.some((a) => a.id === brazil.from) && accounts.some((a) => a.id === brazil.to) ? brazil : undefined
  const rows: Cell[][] = [[
    { value: 'Categoria', fontWeight: 'bold' }, { value: 'Estabelecimento', fontWeight: 'bold' },
    ...months.map((m, i) => ({ value: labels(m) + (i > cur && cur >= 0 ? ' (prev.)' : ''), fontWeight: 'bold' as const, ...(ahead(i) ? { backgroundColor: PROJ } : {}) })),
  ]]
  rows.push(link ? [{ value: 'Câmbio (R$ por 1 da moeda de origem)', fontWeight: 'bold' }, null, { value: round(link.rate), format: '0.0000', backgroundColor: PROJ }] : [])
  const num = (v: number | string, i: number, bold = false): Cell => ({
    // A formula is written without its "=": the file stores it bare, and Excel asks to repair one with it.
    ...(typeof v === 'string' ? { value: v.slice(1), type: 'Formula' as const } : { value: v }), format: NUM,
    ...(bold ? { fontWeight: 'bold' as const } : {}), ...(ahead(i) ? { backgroundColor: PROJ } : {}),
  })
  const r = () => rows.length + 1 // Excel number of the row about to be pushed
  // Brazil: the received row and its formula ingredients, filled in once every block has its rows.
  const est = { months: [] as number[], sentRow: 0, receivedRow: 0, openingRow: 0, bills: [] as number[] }
  const arrived = link ? new Set(months.filter((m) => sentToBrazil(txs.filter((t) => t.account_id === link.to).map((t) => ({ ...t, value: t.amount, description: t.description ?? '' })), m))) : new Set<string>()
  if (link) est.months = months.map((_, i) => i).filter((i) => ahead(i) && !arrived.has(months[i]))

  for (const a of accounts) {
    const isTo = a.id === link?.to, isFrom = a.id === link?.from
    // In the Itaú account the card is its bill total, an expense line of its own.
    const mine = txs.filter((t) => t.account_id === a.id).map((t) => (isTo && (t.categoryName === 'Cartão Itaú' || isCardBillPayment({ bank_category: t.bank_category ?? null, description: t.description ?? '' }))
      ? { ...t, kind: 'expense' as const, categoryName: BILL, merchant: BILL } : t))
      .map((t) => (t.kind === 'income' && t.categoryName === salary && Number(t.booking_date.slice(8, 10)) >= SALARY_FROM_DAY ? { ...t, month: nextMonth(t.month) } : t))
    // A salary credited just before the first month is in the bank's opening balance but shows in
    // the first month: taken out of the opening so it is not counted twice.
    const openingBalance = a.opening - mine.filter((t) => t.month === months[0] && t.booking_date.slice(0, 7) < months[0]).reduce((s, t) => s + t.amount, 0)
    const idx = new Map(months.map((m, i) => [m, i]))
    // kind → category → merchant → value per month
    const grid = new Map<Kind, Map<string, Map<string, number[]>>>()
    const cell = (kind: Kind, cat: string, merchant: string) => {
      const byCat = grid.get(kind) ?? grid.set(kind, new Map()).get(kind)!
      const byM = byCat.get(cat) ?? byCat.set(cat, new Map()).get(cat)!
      return byM.get(merchant) ?? byM.set(merchant, months.map(() => 0)).get(merchant)!
    }
    const seen = new Set<string>() // kind/merchant/month present in the statements
    for (const t of mine) {
      const i = idx.get(t.month)
      if (i === undefined) continue
      cell(t.kind, t.categoryName, t.merchant)[i] += t.amount
      seen.add(`${t.kind}/${t.merchant}/${t.month}`)
    }
    // Recurring lines not in yet, from the current month on.
    const plan: PlanTx[] = mine.map((t) => ({ month: t.month, value: t.amount, kind: t.kind, categoryName: t.categoryName, merchant: t.merchant, booking_date: t.booking_date }))
    const steady = steadyIncomes(plan, avgMonths)
    const recurring = recurringExpectations(plan, (m, kind) => m !== BILL && isRecurring(m, kind, steady), avgMonths)
    for (const e of recurring) {
      for (let i = Math.max(cur, 0); cur >= 0 && i < months.length; i++) {
        if (!seen.has(`${e.kind}/${e.merchant}/${months[i]}`)) cell(e.kind, e.categoryName, e.merchant)[i] += e.kind === 'income' ? e.amount : -e.amount
      }
    }
    const avgSet = new Set(avgMonths)
    // The card bill of the months not paid yet: the projection, or else its 3-month average.
    if (isTo && link) {
      const avgBill = -mine.filter((t) => t.merchant === BILL && avgSet.has(t.month)).reduce((s, t) => s + t.amount, 0) / avgMonths.length
      for (let i = Math.max(cur, 0); cur >= 0 && i < months.length; i++) {
        const v = seen.has(`expense/${BILL}/${months[i]}`) ? 0 : link.bill(months[i]) || avgBill
        if (v > 0.005) cell('expense', BILL, BILL)[i] -= v
      }
    }
    // Future months: the rest of each category up to its 3-month average.
    const media = new Map<string, number>()
    for (const t of mine) if (t.kind !== 'transfer' && t.categoryName !== BILL && avgSet.has(t.month)) media.set(`${t.kind}/${t.categoryName}`, (media.get(`${t.kind}/${t.categoryName}`) ?? 0) + mag(t.kind, t.amount) / avgMonths.length)
    for (const [key, avg] of media) {
      const kind = key.slice(0, key.indexOf('/')) as Kind, cat = key.slice(key.indexOf('/') + 1)
      for (let i = cur + 1; cur >= 0 && i < months.length; i++) {
        const has = [...(grid.get(kind)?.get(cat)?.values() ?? [])].reduce((s, v) => s + mag(kind, v[i]), 0)
        const rest = avg - has
        if (rest > 0.005) cell(kind, cat, OTHERS)[i] += kind === 'income' ? rest : -rest
      }
    }
    // Rows of the estimated transfer; their formulas are set below, once every block has its rows.
    if (link && est.months.length && (isTo || isFrom)) cell('transfer', isTo ? RECEIVED : SENT, isTo ? RECEIVED : SENT)
    const recurringExpense = new Set(recurring.filter((e) => e.kind === 'expense').map((e) => e.merchant))

    // An account with nothing in the period and no balance would be a block of zeros: left out.
    const empty = ![...grid.values()].some((byCat) => [...byCat.values()].some((ms) => [...ms].some(([m, v]) => keep(m, v))))
    if (empty && Math.abs(openingBalance) < 0.005) continue
    rows.push([{ value: `${a.name} (${a.currency})`, fontWeight: 'bold' }])
    const opening = r()
    const openRow: Cell[] = ['Saldo inicial', null] // months filled once the closing row is known
    rows.push(openRow)
    const totals: number[] = []
    for (const [kind, label] of SECTIONS) {
      const cats = [...(grid.get(kind) ?? [])]
        .map(([cat, ms]) => ({ cat, ms: [...ms].filter(([m, v]) => keep(m, v)) }))
        .filter((c) => c.ms.length)
      if (!cats.length) continue
      const abs = (v: number[]) => v.reduce((s, x) => s + Math.abs(x), 0)
      cats.sort((x, y) => abs(y.ms.flatMap(([, v]) => v)) - abs(x.ms.flatMap(([, v]) => v)))
      rows.push([{ value: label, fontWeight: 'bold' }])
      const catRows: number[] = []
      for (const { cat, ms } of cats) {
        ms.sort(([ka, a], [kb, b]) => (ka === OTHERS ? 1 : kb === OTHERS ? -1 : abs(b) - abs(a)))
        const at = r()
        catRows.push(at)
        rows.push([{ value: cat, fontWeight: 'bold' }, null, ...months.map((_, i) => num(`=SUM(${col(i)}${at + 1}:${col(i)}${at + ms.length})`, i, true))])
        for (const [merchant, v] of ms) {
          if (isTo && (merchant === BILL || recurringExpense.has(merchant))) est.bills.push(r())
          if (merchant === RECEIVED) est.receivedRow = r()
          if (merchant === SENT) est.sentRow = r()
          rows.push([null, { value: merchant, indent: 1 }, ...v.map((x, i) => num(round(x), i))])
        }
      }
      totals.push(r())
      rows.push([{ value: `Total ${label.toLowerCase()}`, fontWeight: 'bold' }, null, ...months.map((_, i) => num(`=${catRows.map((n) => `${col(i)}${n}`).join('+')}`, i, true))])
    }
    if (isTo) est.openingRow = opening
    const result = r()
    rows.push([{ value: 'Resultado do mês', fontWeight: 'bold' }, null, ...months.map((_, i) => num(totals.length ? `=${totals.map((n) => `${col(i)}${n}`).join('+')}` : 0, i, true))])
    const close = r()
    rows.push([{ value: 'Saldo final', fontWeight: 'bold' }, null, ...months.map((_, i) => num(`=${col(i)}${opening}+${col(i)}${result}`, i, true))])
    // The opening of each month after the first points at the previous closing.
    openRow.push(...months.map((_, i) => num(i === 0 ? round(openingBalance) : `=${col(i - 1)}${close}`, i, true)))
    rows.push([])
  }

  // Painel alert rule per month: bill + recurring bills − opening balance of the Itaú account,
  // rounded up to 10 and never negative; the sender pays it at the exchange rate.
  if (link && est.receivedRow && est.sentRow) {
    for (const i of est.months) {
      const c = col(i)
      const need = est.bills.length ? `-(${est.bills.map((n) => `${c}${n}`).join('+')})` : '0'
      rows[est.receivedRow - 1][2 + i] = num(`=MAX(0,CEILING(${need}-${c}${est.openingRow},10))`, i)
      rows[est.sentRow - 1][2 + i] = num(`=-${c}${est.receivedRow}/$C$${RATE_ROW}`, i)
    }
  }
  return rows
}

/**
 * Card bill expected in `month`, as the Painel does for the next one: the imported open bills due
 * then; else the purchases already assigned to that bill; else, for the bill right after the
 * current month, the purchases of the current month. 0 when there is nothing to go on.
 */
export function projectCardBill(month: string, current: string, openBills: { due_date: string; total: number }[], buys: { month: string; amount: number; statement_due?: string | null }[]): number {
  const open = openBills.filter((b) => b.due_date.slice(0, 7) === month).reduce((s, b) => s + b.total, 0)
  if (open > 0) return open
  const due = -buys.filter((t) => t.statement_due?.slice(0, 7) === month).reduce((s, t) => s + t.amount, 0)
  if (due > 0) return due
  return month === nextMonth(current) ? -buys.filter((t) => t.month === current).reduce((s, t) => s + t.amount, 0) : 0
}
