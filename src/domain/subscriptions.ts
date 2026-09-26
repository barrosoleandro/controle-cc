export interface SubTx { booking_date: string; amount: number; merchant: string; kind: string }

export interface Subscription {
  merchant: string
  cadence: 'weekly' | 'monthly' | 'quarterly' | 'yearly'
  intervalDays: number
  lastAmount: number
  avgAmount: number
  monthlyCost: number
  count: number
  firstDate: string
  lastDate: string
  nextDate: string
  priceChangePct: number // last vs median of previous
  status: 'active' | 'new' | 'possibly_cancelled'
}

const DAY = 86400000
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY)
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
/** Calendar-aware next charge: same day next month/quarter/year, otherwise median gap. */
function nextDate(last: string, cadence: string, gap: number): string {
  const d = new Date(`${last}T00:00:00Z`)
  const months = cadence === 'monthly' ? 1 : cadence === 'quarterly' ? 3 : cadence === 'yearly' ? 12 : 0
  if (!months) return new Date(d.getTime() + gap * DAY).toISOString().slice(0, 10)
  const day = d.getUTCDate()
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + months)
  const last2 = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, last2))
  return d.toISOString().slice(0, 10)
}

const CADENCES = [
  { cadence: 'weekly', min: 6, max: 8, perMonth: 52 / 12 },
  { cadence: 'monthly', min: 26, max: 35, perMonth: 1 },
  { cadence: 'quarterly', min: 85, max: 97, perMonth: 1 / 3 },
  { cadence: 'yearly', min: 350, max: 380, perMonth: 1 / 12 },
] as const

/**
 * Detects recurring charges: same merchant, regular interval (median gap inside a cadence
 * window and ≥70% of gaps inside it) and stable amount (each within ±25% of median).
 */
export function detectSubscriptions(txs: SubTx[], today: string, minCount = 3): Subscription[] {
  const groups = new Map<string, SubTx[]>()
  for (const t of txs) {
    if (t.kind !== 'expense' || t.amount >= 0 || !t.merchant) continue
    const g = groups.get(t.merchant) ?? []
    g.push(t)
    groups.set(t.merchant, g)
  }
  const out: Subscription[] = []
  for (const [merchant, list] of groups) {
    if (list.length < minCount) continue
    list.sort((a, b) => a.booking_date.localeCompare(b.booking_date))
    const amounts = list.map((t) => -t.amount)
    const med = median(amounts)
    if (amounts.filter((a) => Math.abs(a - med) <= med * 0.25).length / amounts.length < 0.8) continue
    const gaps = list.slice(1).map((t, i) => days(list[i].booking_date, t.booking_date)).filter((g) => g > 2)
    if (gaps.length < minCount - 1) continue
    const gMed = median(gaps)
    const c = CADENCES.find((x) => gMed >= x.min && gMed <= x.max)
    if (!c) continue
    if (gaps.filter((g) => g >= c.min * 0.8 && g <= c.max * 1.2).length / gaps.length < 0.7) continue
    const last = list.at(-1)!
    const prev = amounts.slice(0, -1)
    const priceChangePct = prev.length ? (amounts.at(-1)! - median(prev)) / median(prev) : 0
    const since = days(last.booking_date, today)
    const status = since > gMed * 1.6 ? 'possibly_cancelled' : days(list[0].booking_date, today) < 75 ? 'new' : 'active'
    out.push({
      merchant, cadence: c.cadence, intervalDays: gMed,
      lastAmount: amounts.at(-1)!, avgAmount: amounts.reduce((s, a) => s + a, 0) / amounts.length,
      monthlyCost: med * c.perMonth, count: list.length,
      firstDate: list[0].booking_date, lastDate: last.booking_date,
      nextDate: nextDate(last.booking_date, c.cadence, gMed),
      priceChangePct, status,
    })
  }
  return out.sort((a, b) => b.monthlyCost - a.monthlyCost)
}

export interface Alert { key: string; level: 'info' | 'warn'; text: string }

export function subscriptionAlerts(subs: Subscription[], today: string, fmt: (n: number) => string): Alert[] {
  const alerts: Alert[] = []
  for (const s of subs) {
    if (s.status === 'possibly_cancelled') continue
    if (s.priceChangePct > 0.05)
      alerts.push({ key: `price:${s.merchant}:${s.lastDate}`, level: 'warn', text: `${s.merchant}: price up ${(s.priceChangePct * 100).toFixed(0)}% (now ${fmt(s.lastAmount)}).` })
    if (s.status === 'new')
      alerts.push({ key: `new:${s.merchant}`, level: 'info', text: `New recurring charge detected: ${s.merchant} (${fmt(s.avgAmount)} ${s.cadence}).` })
    const d = days(today, s.nextDate)
    if (d >= 0 && d <= 7)
      alerts.push({ key: `due:${s.merchant}:${s.nextDate}`, level: 'info', text: `${s.merchant} expected on ${s.nextDate} (~${fmt(s.lastAmount)}).` })
    if (s.cadence === 'yearly' && d >= 0 && d <= 30)
      alerts.push({ key: `renew:${s.merchant}:${s.nextDate}`, level: 'warn', text: `Annual renewal of ${s.merchant} in ${d} days — cancel now if not needed.` })
  }
  return alerts
}
