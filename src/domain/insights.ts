import type { EnrichedTx } from './analytics'
import { avgByCategory, byCategory } from './analytics'
import type { Subscription } from './subscriptions'

export interface Insight { key: string; severity: 1 | 2 | 3; title: string; detail: string; monthlySaving?: number }

interface Input {
  txs: EnrichedTx[]
  last3: string[] // last 3 complete months
  current: string // current month yyyy-mm
  budgets: Map<string, number> // category → monthly budget (display currency)
  subs: Subscription[]
  checkingBalance: number // current balance of checking accounts (display currency)
  fmt: (n: number) => string
}

/** Rule-based, explainable savings suggestions. Ranked by estimated monthly saving. */
export function savingsInsights({ txs, last3, current, budgets, subs, checkingBalance, fmt }: Input): Insight[] {
  const out: Insight[] = []
  const avg = avgByCategory(txs, last3)
  const prevMonth = last3.at(-1)
  const prev = prevMonth ? new Map(byCategory(txs, new Set([prevMonth])).map((x) => [x.name, x.value])) : new Map()
  const monthExpense = [...avg.values()].reduce((s, v) => s + v, 0)

  // 1. Categories structurally over budget (3-month average).
  for (const [cat, a] of avg) {
    const b = budgets.get(cat)
    if (b !== undefined && b > 0 && a > b * 1.1 && a - b > 30)
      out.push({ key: `over:${cat}`, severity: 2, title: `${cat} is ${fmt(a - b)}/month over budget`,
        detail: `3-month average ${fmt(a)} vs budget ${fmt(b)}. Either cut it back or raise the budget so the plan is honest.`, monthlySaving: a - b })
  }
  // 2. Last month spike vs 3-month average.
  for (const [cat, v] of prev) {
    const a = avg.get(cat) ?? 0
    if (v > a * 1.3 && v - a > 80)
      out.push({ key: `spike:${cat}:${prevMonth}`, severity: 1, title: `${cat} jumped in ${prevMonth}`,
        detail: `${fmt(v)} vs ${fmt(a)} average. Check whether it was one-off.` })
  }
  // 3. Subscriptions.
  const active = subs.filter((s) => s.status !== 'possibly_cancelled')
  const subTotal = active.reduce((s, x) => s + x.monthlyCost, 0)
  if (active.length)
    out.push({ key: 'subs', severity: 2, title: `${active.length} recurring charges = ${fmt(subTotal)}/month (${fmt(subTotal * 12)}/year)`,
      detail: `Review: ${active.slice(0, 6).map((s) => `${s.merchant} ${fmt(s.monthlyCost)}`).join(', ')}. Cancelling the two smallest you don't use weekly is the fastest win.`,
      monthlySaving: active.slice(-2).reduce((s, x) => s + x.monthlyCost, 0) })
  // 4. Eating out & delivery share.
  const food = (avg.get('Restaurante') ?? 0)
  const groceries = (avg.get('Mercado') ?? 0) + (avg.get('Picard') ?? 0) + (avg.get('Padaria') ?? 0)
  if (food > 400 && food > groceries * 0.5)
    out.push({ key: 'food', severity: 2, title: `Eating out/delivery costs ${fmt(food)}/month`,
      detail: `That's ${Math.round((food / Math.max(1, groceries)) * 100)}% of your groceries. Halving delivery (Uber Eats/iFood) is typically the easiest 25–40% cut.`, monthlySaving: food * 0.3 })
  // 5. Small frequent purchases.
  const freq = new Map<string, { n: number; total: number }>()
  for (const t of txs) {
    if (t.kind !== 'expense' || !last3.includes(t.month) || -t.value > 25) continue
    const f = freq.get(t.merchant) ?? { n: 0, total: 0 }
    f.n++; f.total -= t.value
    freq.set(t.merchant, f)
  }
  for (const [m, f] of freq) if (f.n >= 12)
    out.push({ key: `small:${m}`, severity: 1, title: `${f.n} small purchases at ${m} in 3 months`,
      detail: `${fmt(f.total)} in total (${fmt(f.total / 3)}/month). Small tickets add up.`, monthlySaving: f.total / 6 })
  // 6. Bank fees / FX costs.
  const fees = avg.get('Conta') ?? 0
  if (fees > 15)
    out.push({ key: 'fees', severity: 2, title: `Bank fees & FX costs ≈ ${fmt(fees)}/month`,
      detail: `Includes card FX commissions and IOF câmbio. Pay abroad with a no-FX-fee card (e.g. Wise) and batch BRL transfers.`, monthlySaving: fees * 0.6 })
  // 7. Idle cash on the checking account.
  if (monthExpense > 0 && checkingBalance > monthExpense * 1.5)
    out.push({ key: 'idle', severity: 3, title: `${fmt(checkingBalance - monthExpense)} idle on checking accounts`,
      detail: `Keep ~1 month of expenses (${fmt(monthExpense)}) on checking and sweep the rest to regulated savings (Livret A cap 22,950 €, LDDS 12,000 €) or your investment plan.` })
  // 8. Month-to-date pace.
  const mtd = byCategory(txs, new Set([current])).reduce((s, x) => s + x.value, 0)
  const day = new Date().getDate()
  if (monthExpense > 0 && day >= 7 && mtd / day * 30 > monthExpense * 1.2)
    out.push({ key: `pace:${current}`, severity: 2, title: `Spending pace is ${Math.round((mtd / day * 30 / monthExpense - 1) * 100)}% above your average`,
      detail: `${fmt(mtd)} spent so far this month.` })
  // 9. Data quality.
  const exp3 = txs.filter((t) => t.kind === 'expense' && last3.includes(t.month))
  const unc = exp3.filter((t) => t.categoryName === 'Outros').reduce((s, t) => s - t.value, 0)
  const tot = exp3.reduce((s, t) => s - t.value, 0)
  if (tot > 0 && unc / tot > 0.1)
    out.push({ key: 'quality', severity: 1, title: `${Math.round((unc / tot) * 100)}% of spending is in "Outros"`,
      detail: 'Categorize the biggest ones and create rules — the analysis is only as good as the categories.' })

  return out.sort((a, b) => b.severity - a.severity || (b.monthlySaving ?? 0) - (a.monthlySaving ?? 0))
}
