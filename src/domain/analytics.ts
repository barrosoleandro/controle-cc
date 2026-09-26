import type { Account, Category, Currency, Transaction } from './types'
import type { FxTable } from './fx'

export interface EnrichedTx extends Transaction {
  month: string // yyyy-mm
  value: number // amount in display currency
  categoryName: string
  kind: 'income' | 'expense' | 'transfer'
  accountName: string
}

export function enrich(
  txs: Transaction[], categories: Category[], accounts: Account[], fx: FxTable, display: Currency,
): EnrichedTx[] {
  const cat = new Map(categories.map((c) => [c.id, c]))
  const acc = new Map(accounts.map((a) => [a.id, a]))
  return txs.map((t) => {
    const c = t.category_id ? cat.get(t.category_id) : undefined
    return {
      ...t,
      month: t.booking_date.slice(0, 7),
      value: fx.convert(Number(t.amount), t.currency, display, t.booking_date),
      categoryName: c?.name ?? (t.amount >= 0 ? 'Outras receitas' : 'Outros'),
      kind: c?.kind ?? (t.amount >= 0 ? 'income' : 'expense'),
      accountName: acc.get(t.account_id)?.name ?? '?',
    }
  })
}

export interface MonthSummary { month: string; income: number; expense: number; net: number }

/** Income/expense per month, transfers excluded. Expenses returned as positive numbers. */
export function monthly(txs: EnrichedTx[]): MonthSummary[] {
  const map = new Map<string, MonthSummary>()
  for (const t of txs) {
    if (t.kind === 'transfer') continue
    const m = map.get(t.month) ?? { month: t.month, income: 0, expense: 0, net: 0 }
    if (t.kind === 'income') m.income += t.value
    else m.expense -= t.value // refunds inside an expense category reduce the expense
    m.net = m.income - m.expense
    map.set(t.month, m)
  }
  return [...map.values()].sort((a, b) => a.month.localeCompare(b.month))
}

/** Expense per category (positive), optionally for a set of months. */
export function byCategory(txs: EnrichedTx[], months?: Set<string>): { name: string; value: number }[] {
  const map = new Map<string, number>()
  for (const t of txs) {
    if (t.kind !== 'expense' || (months && !months.has(t.month))) continue
    map.set(t.categoryName, (map.get(t.categoryName) ?? 0) - t.value)
  }
  return [...map].map(([name, value]) => ({ name, value })).filter((x) => x.value > 0.005).sort((a, b) => b.value - a.value)
}

export function topMerchants(txs: EnrichedTx[], months: Set<string>, n = 10) {
  const map = new Map<string, { merchant: string; count: number; total: number }>()
  for (const t of txs) {
    if (t.kind !== 'expense' || !months.has(t.month)) continue
    const m = map.get(t.merchant) ?? { merchant: t.merchant, count: 0, total: 0 }
    m.count++
    m.total -= t.value
    map.set(t.merchant, m)
  }
  return [...map.values()].sort((a, b) => b.total - a.total).slice(0, n)
}

/** Average monthly expense per category over the last `n` complete months. */
export function avgByCategory(txs: EnrichedTx[], lastMonths: string[]): Map<string, number> {
  const set = new Set(lastMonths)
  const res = new Map<string, number>()
  for (const x of byCategory(txs, set)) res.set(x.name, x.value / Math.max(1, lastMonths.length))
  return res
}

/** Last `n` complete months before `today` (yyyy-mm), oldest first. */
export function lastCompleteMonths(today: Date, n: number): string[] {
  const out: string[] = []
  for (let i = n; i >= 1; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1))
    out.push(d.toISOString().slice(0, 7))
  }
  return out
}

/** Daily running balance for an account: opening + cumulative transactions. */
export function balanceSeries(account: Account, txs: Transaction[]) {
  const list = txs.filter((t) => t.account_id === account.id).sort((a, b) => a.booking_date.localeCompare(b.booking_date))
  let bal = Number(account.opening_balance)
  const out: { date: string; balance: number }[] = []
  for (const t of list) {
    bal += Number(t.amount)
    if (out.at(-1)?.date === t.booking_date) out.at(-1)!.balance = bal
    else out.push({ date: t.booking_date, balance: bal })
  }
  return out.map((p) => ({ ...p, balance: Math.round(p.balance * 100) / 100 }))
}
