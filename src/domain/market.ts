/**
 * Comparing your own pay with recorded market figures. Every number here comes from a
 * payslip or from a benchmark entry somebody wrote down with its source; nothing is
 * estimated and nothing is fetched. The AI narration on top of this gets these results
 * as facts and is forbidden from producing a market figure of its own.
 */

export type Basis = 'gross_year' | 'gross_month' | 'net_month' | 'total_comp_year'
export type Currency = 'EUR' | 'BRL'

export interface BenchmarkEntry {
  id: string
  role_id: string
  as_of: string // yyyy-mm-dd
  source: string
  source_url: string
  basis: Basis
  currency: Currency
  p25: number | null
  p50: number | null
  p75: number | null
  sample_size: number | null
  official: boolean
  notes: string
}

export interface BenchmarkRole {
  id: string
  name: string
  scope: 'regional' | 'global' | 'nacional' | 'local'
  region: string
  notes: string
  sort: number
}

export const BASIS_LABEL: Record<Basis, string> = {
  gross_year: 'bruto anual',
  gross_month: 'bruto mensal',
  net_month: 'líquido mensal',
  total_comp_year: 'remuneração total anual',
}

/** The roles to start from; the user adds the rest. */
export const SEED_ROLES: Omit<BenchmarkRole, 'id'>[] = [
  { name: 'CIO regional', scope: 'regional', region: 'Europa', notes: 'Responsável de TI para uma região', sort: 0 },
  { name: 'CIO global', scope: 'global', region: 'Global', notes: 'Responsável de TI do grupo', sort: 1 },
  { name: 'Head de Dados', scope: 'regional', region: 'Europa', notes: 'Responsável de dados e analytics', sort: 2 },
]

/** Everything expressed as gross per year, which is how offers are usually discussed. */
export function toGrossYear(value: number, basis: Basis): number | null {
  switch (basis) {
    case 'gross_year': return value
    case 'total_comp_year': return value
    case 'gross_month': return value * 12
    // A net figure cannot be turned into gross without the whole payroll calculation.
    case 'net_month': return null
  }
}

export interface Position {
  /** 0 = at p25, 0.5 = at the median, 1 = at p75; outside the band it goes beyond. */
  ratioToMedian: number
  band: 'abaixo de p25' | 'entre p25 e p50' | 'entre p50 e p75' | 'acima de p75' | 'sem faixa'
  /** How much the median is above (positive) or below (negative) your pay. */
  gapToMedian: number | null
}

/**
 * Where a figure sits against one benchmark. Only the quartiles the source actually
 * published are used: a missing p25 means the band simply cannot be narrowed.
 */
export function position(mine: number, e: Pick<BenchmarkEntry, 'p25' | 'p50' | 'p75'>): Position {
  const { p25, p50, p75 } = e
  const gapToMedian = p50 === null ? null : p50 - mine
  const ratioToMedian = p50 ? mine / p50 : 0
  let band: Position['band'] = 'sem faixa'
  if (p25 !== null && mine < p25) band = 'abaixo de p25'
  else if (p75 !== null && mine > p75) band = 'acima de p75'
  else if (p50 !== null && mine < p50 && (p25 === null || mine >= p25)) band = 'entre p25 e p50'
  else if (p50 !== null && mine >= p50 && (p75 === null || mine <= p75)) band = 'entre p50 e p75'
  return { ratioToMedian, band, gapToMedian }
}

export interface RoleComparison {
  role: BenchmarkRole
  /** Latest entry per source, newest first: what the market says right now. */
  latest: { entry: BenchmarkEntry; grossYear: number | null; position: Position | null }[]
  /** Median over time, oldest first, for the history chart. */
  history: { as_of: string; source: string; p50GrossYear: number }[]
}

/**
 * Groups the recorded entries by role: the most recent reading of each source, plus the
 * whole series so the history is visible. Entries whose basis cannot be converted (a net
 * figure) are kept but carry no comparison.
 */
export function compareRole(role: BenchmarkRole, entries: BenchmarkEntry[], myGrossYear: number | null): RoleComparison {
  const mine = entries.filter((e) => e.role_id === role.id)
  const bySource = new Map<string, BenchmarkEntry>()
  for (const e of [...mine].sort((a, b) => a.as_of.localeCompare(b.as_of))) bySource.set(`${e.source}|${e.basis}`, e)

  const latest = [...bySource.values()]
    .sort((a, b) => b.as_of.localeCompare(a.as_of))
    .map((entry) => {
      const grossYear = entry.p50 === null ? null : toGrossYear(entry.p50, entry.basis)
      return {
        entry,
        grossYear,
        position: myGrossYear !== null && grossYear !== null
          ? position(myGrossYear, {
            p25: entry.p25 === null ? null : toGrossYear(entry.p25, entry.basis),
            p50: grossYear,
            p75: entry.p75 === null ? null : toGrossYear(entry.p75, entry.basis),
          })
          : null,
      }
    })

  const history = mine
    .filter((e) => e.p50 !== null && toGrossYear(e.p50, e.basis) !== null)
    .map((e) => ({ as_of: e.as_of, source: e.source, p50GrossYear: toGrossYear(e.p50!, e.basis)! }))
    .sort((a, b) => a.as_of.localeCompare(b.as_of))

  return { role, latest, history }
}

/**
 * Your own gross per year from the payslips: the last twelve months when they are all
 * there, otherwise the last month annualised, which is flagged so the screen can say so.
 */
export function myGrossYear(payslips: { period: string; gross: number | null }[]): { value: number | null; from: 'ano' | 'mes' | null; months: number } {
  const withGross = payslips.filter((p) => p.gross !== null).sort((a, b) => b.period.localeCompare(a.period))
  if (!withGross.length) return { value: null, from: null, months: 0 }
  const last12 = withGross.slice(0, 12)
  if (last12.length === 12) return { value: last12.reduce((s, p) => s + (p.gross ?? 0), 0), from: 'ano', months: 12 }
  return { value: (withGross[0].gross ?? 0) * 12, from: 'mes', months: withGross.length }
}
