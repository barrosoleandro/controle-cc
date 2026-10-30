/**
 * Simulation workbook of Lançamentos: one block per account, one under the other, with the same
 * months as columns (11 back, the current one, 2 ahead). Rows are category subtotals (formulas)
 * over merchant rows (values), so changing any value in Excel flows into the totals and the
 * month-to-month balance. Values are in the account's own currency: income positive, expenses
 * and money sent negative.
 *
 * Current month: what came in plus the recurring lines not in yet. Future months: the same,
 * plus "(demais, média 3 meses)" per category, so a category is at least its 3-month average.
 */
import type { Cell } from 'write-excel-file/browser'
import { recurringExpectations, steadyIncomes, type PlanTx } from './monthPlan'

export type Kind = 'income' | 'expense' | 'transfer'
export interface SimTx { account_id: string; month: string; amount: number; kind: Kind; categoryName: string; merchant: string; booking_date: string }
export interface SimAccount { id: string; name: string; currency: string; opening: number } // opening: balance before the first month
/** Recurring flag; `steady`: the account's incomes that came in every average month (recurring unless unmarked). */
export type IsRecurring = (merchant: string, kind: 'income' | 'expense', steady: Set<string>) => boolean

export type { Cell }
export const OTHERS = '(demais, média 3 meses)'
const NUM = '#,##0.00;[Red]-#,##0.00'
const PROJ = '#FFF4D6' // background of the months that are (partly) projected
const SECTIONS: [Kind, string][] = [['income', 'Receitas'], ['expense', 'Despesas'], ['transfer', 'Transferências']]

const col = (i: number) => String.fromCharCode(67 + i) // month i → C, D, …
const round = (v: number) => Math.round(v * 100) / 100
/** Sign that makes a value positive for its kind: income counts up, the rest counts down. */
const mag = (kind: Kind, v: number) => (kind === 'income' ? v : -v)

export function buildSimSheet(accounts: SimAccount[], txs: SimTx[], months: string[], current: string, avgMonths: string[], isRecurring: IsRecurring, labels: (m: string) => string): Cell[][] {
  const cur = months.indexOf(current)
  const projected = (i: number) => cur >= 0 && i >= cur
  const rows: Cell[][] = [[
    { value: 'Categoria', fontWeight: 'bold' }, { value: 'Estabelecimento', fontWeight: 'bold' },
    ...months.map((m, i) => ({ value: labels(m) + (i > cur && cur >= 0 ? ' (prev.)' : ''), fontWeight: 'bold' as const, ...(projected(i) ? { backgroundColor: PROJ } : {}) })),
  ]]
  const num = (v: number | string, i: number, bold = false): Cell => ({
    // A formula is written without its "=": the file stores it bare, and Excel asks to repair one with it.
    ...(typeof v === 'string' ? { value: v.slice(1), type: 'Formula' as const } : { value: v }), format: NUM,
    ...(bold ? { fontWeight: 'bold' as const } : {}), ...(projected(i) ? { backgroundColor: PROJ } : {}),
  })
  const r = () => rows.length + 1 // Excel number of the row about to be pushed

  for (const a of accounts) {
    const mine = txs.filter((t) => t.account_id === a.id)
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
    for (const e of recurringExpectations(plan, (m, kind) => isRecurring(m, kind, steady), avgMonths)) {
      for (let i = Math.max(cur, 0); cur >= 0 && i < months.length; i++) {
        if (!seen.has(`${e.kind}/${e.merchant}/${months[i]}`)) cell(e.kind, e.categoryName, e.merchant)[i] += e.kind === 'income' ? e.amount : -e.amount
      }
    }
    // Future months: the rest of each category up to its 3-month average.
    const avgSet = new Set(avgMonths)
    const media = new Map<string, number>()
    for (const t of mine) if (t.kind !== 'transfer' && avgSet.has(t.month)) media.set(`${t.kind}/${t.categoryName}`, (media.get(`${t.kind}/${t.categoryName}`) ?? 0) + mag(t.kind, t.amount) / avgMonths.length)
    for (const [key, avg] of media) {
      const kind = key.slice(0, key.indexOf('/')) as Kind, cat = key.slice(key.indexOf('/') + 1)
      for (let i = cur + 1; cur >= 0 && i < months.length; i++) {
        const has = [...(grid.get(kind)?.get(cat)?.values() ?? [])].reduce((s, v) => s + mag(kind, v[i]), 0)
        const rest = avg - has
        if (rest > 0.005) cell(kind, cat, OTHERS)[i] += kind === 'income' ? rest : -rest
      }
    }

    rows.push([{ value: `${a.name} (${a.currency})`, fontWeight: 'bold' }])
    const opening = r()
    const openRow: Cell[] = ['Saldo inicial', null] // months filled once the closing row is known
    rows.push(openRow)
    const totals: number[] = []
    for (const [kind, label] of SECTIONS) {
      const cats = [...(grid.get(kind) ?? [])]
        .map(([cat, ms]) => ({ cat, ms: [...ms].filter(([, v]) => v.some((x) => Math.abs(x) > 0.005)) }))
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
        for (const [merchant, v] of ms) rows.push([null, { value: merchant, indent: 1 }, ...v.map((x, i) => num(round(x), i))])
      }
      totals.push(r())
      rows.push([{ value: `Total ${label.toLowerCase()}`, fontWeight: 'bold' }, null, ...months.map((_, i) => num(`=${catRows.map((n) => `${col(i)}${n}`).join('+')}`, i, true))])
    }
    const result = r()
    rows.push([{ value: 'Resultado do mês', fontWeight: 'bold' }, null, ...months.map((_, i) => num(totals.length ? `=${totals.map((n) => `${col(i)}${n}`).join('+')}` : 0, i, true))])
    const close = r()
    rows.push([{ value: 'Saldo final', fontWeight: 'bold' }, null, ...months.map((_, i) => num(`=${col(i)}${opening}+${col(i)}${result}`, i, true))])
    // The opening of each month after the first points at the previous closing.
    openRow.push(...months.map((_, i) => num(i === 0 ? round(a.opening) : `=${col(i - 1)}${close}`, i, true)))
    rows.push([])
  }
  return rows
}
