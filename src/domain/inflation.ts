import type { Country } from './countries'

/** Annual consumer-price inflation, % per year. */
export type InflationTable = Record<string, number>

/**
 * Reference values: yearly average CPI change (France INSEE, Portugal INE) and IPCA
 * (Brazil, Dec/Dec). The last years are estimates or assumptions: the user can edit
 * them, and should when official figures come out.
 */
export const DEFAULT_INFLATION: Record<Exclude<Country, 'Outro'>, InflationTable> = {
  França: { 2022: 5.2, 2023: 4.9, 2024: 2.0, 2025: 1.0, 2026: 1.5 },
  Brasil: { 2022: 5.8, 2023: 4.6, 2024: 4.8, 2025: 4.3, 2026: 4.0 },
  Portugal: { 2022: 7.8, 2023: 4.3, 2024: 2.4, 2025: 2.2, 2026: 2.0 },
}
export const ESTIMATED_FROM = 2025 // years from here on are estimates

/** Price level at the end of `to` relative to the start of `from` (yyyy-mm), compounding monthly. */
export function priceIndex(from: string, to: string, table: InflationTable): number {
  let [y, m] = from.split('-').map(Number)
  const [ty, tm] = to.split('-').map(Number)
  let idx = 1
  while (y < ty || (y === ty && m <= tm)) {
    const annual = table[y] ?? table[Math.max(...Object.keys(table).map(Number))] ?? 0
    idx *= (1 + annual / 100) ** (1 / 12)
    if (++m > 12) { m = 1; y++ }
  }
  return idx
}

export interface PayPoint { month: string; gross: number | null; net: number | null }

/**
 * Pay over time against inflation. The reference is the average net of the first three
 * payslips (one month's bonus would skew a single month); "corrected" is that reference
 * grown by inflation, i.e. what keeping the purchasing power would have required.
 */
export function payVsInflation(points: PayPoint[], table: InflationTable) {
  const withNet = points.filter((p) => p.net !== null).sort((a, b) => a.month.localeCompare(b.month))
  if (withNet.length < 2) return null
  const avg = (ps: PayPoint[]) => ps.reduce((s, p) => s + (p.net ?? 0), 0) / ps.length
  const first = withNet.slice(0, 3)
  const last = withNet.slice(-3)
  const base = avg(first)
  const startMonth = first[0].month
  const rows = withNet.map((p) => ({ ...p, corrected: base * priceIndex(startMonth, p.month, table) }))
  const peak = withNet.reduce((a, b) => ((b.net ?? 0) > (a.net ?? 0) ? b : a))
  const inflation = priceIndex(startMonth, withNet.at(-1)!.month, table) - 1
  const recent = avg(last)
  const needed = base * (1 + inflation)
  return {
    rows,
    peak,
    base,
    recent,
    nominalChange: recent / base - 1,
    inflation,
    realChange: recent / needed - 1,
    monthlyGap: recent - needed, // negative = purchasing power lost per month
  }
}
