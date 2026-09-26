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
