import type { Currency } from './types'

/** EUR→BRL daily rates keyed by ISO date. Uses the latest rate on or before the date. */
export class FxTable {
  private dates: string[]
  private rates: Map<string, number>
  private fallback: number
  constructor(rates: Map<string, number>, fallback = 6.0) {
    this.rates = rates
    this.fallback = fallback
    this.dates = [...rates.keys()].sort()
  }
  eurBrl(date: string): number {
    let lo = 0, hi = this.dates.length - 1, found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (this.dates[mid] <= date) { found = mid; lo = mid + 1 } else hi = mid - 1
    }
    if (found >= 0) return this.rates.get(this.dates[found])!
    return this.dates.length ? this.rates.get(this.dates[0])! : this.fallback
  }
  latest(): number {
    return this.dates.length ? this.rates.get(this.dates.at(-1)!)! : this.fallback
  }
  convert(amount: number, from: Currency, to: Currency, date: string): number {
    if (from === to) return amount
    const r = this.eurBrl(date)
    return from === 'EUR' ? amount * r : amount / r
  }
}

/** Fetches ECB reference rates (Frankfurter, no key needed) for a date range. */
export async function fetchEurBrl(from: string, to: string): Promise<Map<string, number>> {
  const res = await fetch(`https://api.frankfurter.dev/v1/${from}..${to}?from=EUR&to=BRL`)
  if (!res.ok) throw new Error(`FX service error ${res.status}`)
  const json = (await res.json()) as { rates: Record<string, { BRL: number }> }
  return new Map(Object.entries(json.rates).map(([d, v]) => [d, v.BRL]))
}
