import type { InflationTable } from './inflation'

/**
 * Official inflation from Eurostat: HICP, annual average rate of change (unit RCH_A_AVG,
 * all-items COICOP CP00). Eurostat is the EU statistics office, needs no key and sends
 * permissive CORS, so the browser can read it directly.
 *
 * Note it is the HICP (IPCH in France), harmonised across the EU, not the national CPI
 * that INSEE publishes as "indice des prix à la consommation". The two differ by a few
 * tenths of a point; the harmonised one is what compares across France and Portugal.
 */

/** Eurostat geo codes for the countries this app knows. Brazil is not in Eurostat. */
export const HICP_GEO: Record<string, string> = { França: 'FR', Portugal: 'PT' }

export const hicpUrl = (geo: string, since = 2019) =>
  'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/prc_hicp_aind'
  + `?format=JSON&lang=EN&unit=RCH_A_AVG&coicop=CP00&geo=${encodeURIComponent(geo)}&sinceTimePeriod=${since}`

/** The slice of JSON-stat 2.0 this parser needs. */
export interface JsonStat {
  label?: string
  updated?: string
  id?: string[]
  size?: number[]
  value?: Record<string, number | null> | (number | null)[]
  dimension?: Record<string, { category?: { index?: Record<string, number> } }>
}

export interface HicpResult {
  rates: InflationTable // year -> % per year
  label: string
  updated: string | null
  lastYear: number | null // last year with an official figure
}

/**
 * Reads one geo out of a JSON-stat answer. Values come keyed by flat index and sparse
 * (a year with no figure yet is simply absent), so the year is resolved through the
 * time dimension's own index rather than by position in an array.
 */
export function parseHicp(body: JsonStat): HicpResult {
  const timeIndex = body.dimension?.time?.category?.index
  if (!timeIndex || !Object.keys(timeIndex).length) throw new Error('Resposta do Eurostat sem a dimensão de tempo.')
  const ids = body.id ?? []
  const sizes = body.size ?? []
  const timePos = ids.indexOf('time')
  if (timePos < 0) throw new Error('Resposta do Eurostat sem a dimensão "time".')
  // Flat index = sum of each dimension's offset times the product of the sizes after it.
  // Only one geo/unit/coicop is requested, so every other coordinate is 0 and the stride
  // of time is the product of the sizes that come after it.
  const stride = sizes.slice(timePos + 1).reduce((a, b) => a * b, 1)
  const at = (i: number): number | null | undefined =>
    Array.isArray(body.value) ? body.value[i] : body.value?.[String(i)]

  const rates: InflationTable = {}
  for (const [year, pos] of Object.entries(timeIndex)) {
    const v = at(pos * stride)
    if (typeof v === 'number' && Number.isFinite(v)) rates[year] = v
  }
  if (!Object.keys(rates).length) throw new Error('O Eurostat respondeu sem nenhum valor de inflação.')
  const years = Object.keys(rates).map(Number).filter(Number.isFinite)
  return {
    rates,
    label: body.label ?? 'HICP (Eurostat)',
    updated: body.updated ?? null,
    lastYear: years.length ? Math.max(...years) : null,
  }
}

/**
 * Merges official figures over whatever is stored, keeping the user's own numbers for the
 * years Eurostat has not published yet — those stay estimates and stay editable.
 */
export function mergeOfficial(current: InflationTable, official: InflationTable): InflationTable {
  return { ...current, ...official }
}
