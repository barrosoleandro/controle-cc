import { supabase } from './supabase'
import type { ParsedPayslip, PayCurrency, PayslipLine } from '../parsers/payslipPdf'
import { mergeUsMonth } from '../parsers/usPayStatementPdf'

export interface Payslip {
  id: string
  period: string // yyyy-mm-01
  currency: PayCurrency // EUR: bulletin de paie (France); USD: US pay statements of the month
  employer: string
  pay_date: string | null
  transfer_date: string | null
  gross: number | null
  employee_contrib: number | null
  employer_contrib: number | null
  employer_cost: number | null
  net_social: number | null
  net_before_tax: number | null
  net_taxable: number | null
  cumul_taxable: number | null
  pas_rate: number | null
  pas_amount: number | null
  net_paid: number | null
  lines: PayslipLine[]
  file_sha256: string
}

const NUMERIC = ['gross', 'employee_contrib', 'employer_contrib', 'employer_cost', 'net_social', 'net_before_tax', 'net_taxable', 'cumul_taxable', 'pas_rate', 'pas_amount', 'net_paid'] as const
const MIGRATION_HINT = 'Holerites em dólar precisam da migração supabase/migrations/009_payslip_currency.sql: rode-a no SQL Editor do Supabase.'

export async function listPayslips(): Promise<Payslip[]> {
  const r = await supabase.from('payslips').select('*').order('period', { ascending: false })
  if (r.error) throw new Error(r.error.message)
  // numeric columns come back as strings from PostgREST; before migration 009 there is no currency (all EUR)
  return (r.data as Payslip[]).map((p) => {
    const out = { ...p, currency: p.currency ?? 'EUR' }
    for (const k of NUMERIC) out[k] = p[k] === null ? null : Number(p[k])
    return out
  })
}

export type SaveOutcome = 'importado' | 'substituído' | 'atualizado' | 'já existia'

/**
 * Upsert by month and currency: importing the same (or a corrected) payslip replaces it instead of
 * duplicating. A US month gathers several statements that may come from different files, so the
 * statements already saved for that month are kept and the new ones added (by document number).
 */
export async function savePayslip(p: ParsedPayslip, sha256: string, saved?: Payslip[]): Promise<SaveOutcome> {
  const currency = p.currency ?? 'EUR'
  const prev = saved?.find((s) => s.period.startsWith(p.period) && s.currency === currency)
  let row = p
  let outcome: SaveOutcome = prev ? 'substituído' : 'importado'
  if (currency === 'USD') {
    if (prev) {
      row = mergeUsMonth(prev.lines, p)
      const docs = (ls: PayslipLine[]) => [...new Set(ls.map((l) => l.doc))].sort().join(',')
      if (docs(row.lines) === docs(prev.lines)) return 'já existia'
      outcome = 'atualizado'
    }
  } else if (prev?.file_sha256 === sha256) return 'já existia'
  const t = row.totals
  const body = {
    period: `${row.period}-01`, employer: row.employer, pay_date: row.payDate, transfer_date: row.transferDate,
    gross: t.gross, employee_contrib: t.employeeContrib, employer_contrib: t.employerContrib, employer_cost: t.employerCost,
    net_social: t.netSocial, net_before_tax: t.netBeforeTax, net_taxable: t.netTaxable, cumul_taxable: t.cumulTaxable,
    pas_rate: t.pasRate, pas_amount: t.pasAmount, net_paid: t.netPaid,
    lines: row.lines, file_sha256: sha256, updated_at: new Date().toISOString(),
  }
  let r = await supabase.from('payslips').upsert({ ...body, currency }, { onConflict: 'user_id,period,currency' })
  // Database still on migration 002 (no currency column, unique per month): euros keep working.
  if (r.error && currency === 'EUR' && /currency|no unique|ON CONFLICT/i.test(r.error.message)) r = await supabase.from('payslips').upsert(body, { onConflict: 'user_id,period' })
  if (r.error) throw new Error(currency === 'USD' && /currency|no unique|ON CONFLICT/i.test(r.error.message) ? MIGRATION_HINT : r.error.message)
  if (saved) {
    const stored = { ...(prev ?? { id: '' }), ...body, currency, period: body.period } as Payslip
    if (prev) saved[saved.indexOf(prev)] = stored; else saved.push(stored)
  }
  return outcome
}

export async function deletePayslip(id: string) {
  const r = await supabase.from('payslips').delete().eq('id', id)
  if (r.error) throw new Error(r.error.message)
}
