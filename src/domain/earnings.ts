import { categoryLabel, cells, type JsonStat } from './jsonstat'

/**
 * Official earnings from Eurostat's Structure of Earnings Survey: mean monthly gross
 * earnings by occupation (ISCO-08) and enterprise size class. Free, no key, CORS open,
 * so the browser reads it directly whenever it is online.
 *
 * Two limits that matter and are surfaced in the UI rather than hidden:
 *  - The finest occupation breakdown published is the ISCO major group. "Managers" (OC1)
 *    covers a CIO and a shop manager alike: an official anchor, not a peer group.
 *  - Cells are withheld where the sample is too small. Luxembourg publishes nothing for
 *    managers, Belgium only one size class. A missing figure is reported as missing.
 */

export const SES_DATASET = 'earn_ses22_25' // 2022 wave, the most recent published
export const SES_YEAR = 2022

/** ISCO-08 groups worth offering; the survey publishes major groups, not job titles. */
export const ISCO: { code: string; label: string }[] = [
  { code: 'OC1', label: 'Diretores e gerentes (ISCO 1)' },
  { code: 'OC2', label: 'Profissionais das ciências e intelectuais (ISCO 2)' },
  { code: 'OC3', label: 'Técnicos de nível médio (ISCO 3)' },
  { code: 'TOTAL', label: 'Todas as ocupações' },
]

/** Enterprise size classes, largest first: the usual peer group for an executive. */
export const SIZE_CLASS: { code: string; label: string }[] = [
  { code: 'GE1000', label: '1000+' },
  { code: '500-999', label: '500–999' },
  { code: '250-499', label: '250–499' },
  { code: '50-249', label: '50–249' },
  { code: '10-49', label: '10–49' },
  { code: '1-9', label: '1–9' },
]

/** Western Europe, plus the EU average as a reference line. */
export const EARNINGS_GEO: { code: string; label: string }[] = [
  { code: 'FR', label: 'França' },
  { code: 'PT', label: 'Portugal' },
  { code: 'ES', label: 'Espanha' },
  { code: 'BE', label: 'Bélgica' },
  { code: 'NL', label: 'Países Baixos' },
  { code: 'LU', label: 'Luxemburgo' },
  { code: 'DE', label: 'Alemanha' },
  { code: 'EU27_2020', label: 'União Europeia (27)' },
]

export const geoLabel = (code: string) => EARNINGS_GEO.find((g) => g.code === code)?.label ?? code

export function earningsUrl(geos: string[], isco = 'OC1'): string {
  const q = new URLSearchParams({
    format: 'JSON', lang: 'EN',
    sex: 'T', // both sexes: a personal benchmark has no reason to split
    indic_se: 'ERN', // mean monthly earnings
    unit: 'EUR',
    isco08: isco,
  })
  for (const g of geos) q.append('geo', g)
  return `https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/${SES_DATASET}?${q}`
}

export interface EarningsRow {
  sizeClass: string
  sizeLabel: string
  monthly: number // mean gross monthly earnings, EUR
}

export interface GeoEarnings {
  geo: string
  label: string
  rows: EarningsRow[] // largest size class first; empty when the country publishes nothing
  /** Largest published class — the closest thing to a big-company peer group. */
  headline: EarningsRow | null
}

export interface EarningsResult {
  label: string
  updated: string | null
  year: number
  iscoLabel: string
  byGeo: GeoEarnings[]
  /** Countries that were asked for but publish nothing for this occupation. */
  withheld: string[]
}

const sizeOrder = new Map(SIZE_CLASS.map((s, i) => [s.code, i]))
const sizeLabel = (code: string) => SIZE_CLASS.find((s) => s.code === code)?.label ?? code

/**
 * Reads the answer for every geo it contains. Withheld cells are absent rather than zero,
 * so a country with no published figure comes back with no rows instead of a false zero.
 */
export function parseEarnings(body: JsonStat, asked: string[] = []): EarningsResult {
  const all = cells(body)
  if (!all.length) throw new Error('O Eurostat respondeu sem nenhum valor para essa combinação.')

  const grouped = new Map<string, EarningsRow[]>()
  for (const c of all) {
    const rows = grouped.get(c.coords.geo) ?? []
    rows.push({ sizeClass: c.coords.sizeclas, sizeLabel: sizeLabel(c.coords.sizeclas), monthly: c.value })
    grouped.set(c.coords.geo, rows)
  }

  const order = new Map(EARNINGS_GEO.map((g, i) => [g.code, i]))
  const byGeo: GeoEarnings[] = [...grouped].map(([geo, rows]) => {
    rows.sort((a, b) => (sizeOrder.get(a.sizeClass) ?? 99) - (sizeOrder.get(b.sizeClass) ?? 99))
    return { geo, label: geoLabel(geo), rows, headline: rows[0] ?? null }
  }).sort((a, b) => (order.get(a.geo) ?? 99) - (order.get(b.geo) ?? 99))

  const isco = all[0].coords.isco08
  return {
    label: body.label ?? 'Eurostat SES',
    updated: body.updated ?? null,
    year: Number(all[0].coords.time) || SES_YEAR,
    iscoLabel: categoryLabel(body, 'isco08', isco),
    byGeo,
    withheld: asked.filter((g) => !grouped.has(g)),
  }
}
