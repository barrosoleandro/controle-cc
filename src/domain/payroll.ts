import type { PayslipLine } from '../parsers/payslipPdf'

/** A monthly amount the employment contract says must be on every payslip. */
export interface ContractItem { code: string; label: string; amount: number }

/** From the CDI offer letter (Apr 2024) + the car benefit printed on every payslip. Editable in the app. */
export const DEFAULT_CONTRACT: ContractItem[] = [
  { code: '1020', label: 'Base mensuelle', amount: 9167 },
  { code: '1669', label: "Prime d'impatriation", amount: 5000 },
  { code: '3026', label: 'Avantage en nature voiture', amount: 552.9 },
]

export type CheckStatus = 'ok' | 'changed' | 'missing'
export interface ContractCheckRow { item: ContractItem; actual: number | null; diff: number | null; status: CheckStatus }
export interface ContractCheck { rows: ContractCheckRow[]; extras: PayslipLine[]; ok: boolean }

const TOLERANCE = 0.01

/**
 * Compares a payslip with the contract: every contract item must be present with the same amount.
 * `extras` lists earnings that are not in the contract (bonus, paid-leave adjustments, PEV…) for review.
 */
export function checkContract(lines: PayslipLine[], contract: ContractItem[]): ContractCheck {
  const rows = contract.map((item): ContractCheckRow => {
    const found = lines.filter((l) => l.code === item.code && l.gain !== null)
    if (!found.length) return { item, actual: null, diff: null, status: 'missing' }
    const actual = Math.round(found.reduce((s, l) => s + (l.gain ?? 0), 0) * 100) / 100
    const diff = Math.round((actual - item.amount) * 100) / 100
    return { item, actual, diff, status: Math.abs(diff) <= TOLERANCE ? 'ok' : 'changed' }
  })
  const codes = new Set(contract.map((c) => c.code))
  const extras = lines.filter((l) => l.code && !l.code.startsWith('/') && l.gain !== null && !codes.has(l.code))
  return { rows, extras, ok: rows.every((r) => r.status === 'ok') }
}

/** One number that moved between two payslips. */
export interface TotalDiff { key: keyof PayslipTotalsLike; label: string; a: number | null; b: number | null; diff: number }

/** One payslip line that moved, by column. A line absent on one side counts as zero there. */
export interface LineDiff {
  code: string | null
  label: string
  field: 'gain' | 'deduction' | 'employer' | 'base' | 'rate'
  a: number
  b: number
  diff: number
  status: 'changed' | 'added' | 'removed'
}

export interface PayslipTotalsLike {
  gross: number | null
  employee_contrib: number | null
  employer_contrib: number | null
  employer_cost: number | null
  net_social: number | null
  net_before_tax: number | null
  net_taxable: number | null
  pas_rate: number | null
  pas_amount: number | null
  net_paid: number | null
}

const TOTAL_LABELS: [keyof PayslipTotalsLike, string][] = [
  ['gross', 'Bruto'],
  ['employee_contrib', 'Contribuições do empregado'],
  ['employer_contrib', 'Contribuições do empregador'],
  ['employer_cost', 'Custo total do empregador'],
  ['net_social', 'Líquido social'],
  ['net_before_tax', 'Líquido antes do IR'],
  ['net_taxable', 'Base tributável'],
  ['pas_rate', 'Alíquota PAS (%)'],
  ['pas_amount', 'IR retido (PAS)'],
  ['net_paid', 'Líquido pago'],
]

const DIFF_FIELDS = ['gain', 'deduction', 'employer', 'base', 'rate'] as const
const EPS = 0.005
const n = (v: number | null | undefined) => (v === null || v === undefined ? 0 : v)
const lineKey = (l: PayslipLine) => `${l.code ?? ''}|${l.label}`

/**
 * What changed from payslip `a` to payslip `b`: the totals that moved and, line by line,
 * every column that moved. Built so that a drop in gross can be traced to the lines that
 * caused it — the sum of the `gain` diffs explains the gross diff.
 */
export function comparePayslips(
  a: { totals: PayslipTotalsLike; lines: PayslipLine[] },
  b: { totals: PayslipTotalsLike; lines: PayslipLine[] },
): { totals: TotalDiff[]; lines: LineDiff[]; gainDiff: number } {
  const totals = TOTAL_LABELS.map(([key, label]): TotalDiff => ({
    key, label, a: a.totals[key], b: b.totals[key], diff: n(b.totals[key]) - n(a.totals[key]),
  })).filter((t) => Math.abs(t.diff) > EPS || (t.a === null) !== (t.b === null))

  const mapA = new Map(a.lines.map((l) => [lineKey(l), l]))
  const mapB = new Map(b.lines.map((l) => [lineKey(l), l]))
  const lines: LineDiff[] = []
  for (const key of new Set([...mapA.keys(), ...mapB.keys()])) {
    const la = mapA.get(key), lb = mapB.get(key)
    const ref = lb ?? la!
    for (const field of DIFF_FIELDS) {
      const va = n(la?.[field]), vb = n(lb?.[field])
      if (Math.abs(vb - va) <= EPS) continue
      lines.push({
        code: ref.code, label: ref.label, field, a: va, b: vb, diff: vb - va,
        status: !la ? 'added' : !lb ? 'removed' : 'changed',
      })
    }
  }
  lines.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff))
  // Only the gain column adds up to the gross, so it is the one worth summing.
  const gainDiff = lines.filter((l) => l.field === 'gain' && l.code !== '/101').reduce((s, l) => s + l.diff, 0)
  return { totals, lines, gainDiff }
}
