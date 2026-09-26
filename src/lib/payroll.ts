import { supabase } from './supabase'
import type { ParsedPayslip, PayslipLine } from '../parsers/payslipPdf'

export interface Payslip {
  id: string
  period: string // yyyy-mm-01
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

export async function listPayslips(): Promise<Payslip[]> {
  const r = await supabase.from('payslips').select('*').order('period', { ascending: false })
  if (r.error) throw new Error(r.error.message)
  // numeric columns come back as strings from PostgREST
  return (r.data as Payslip[]).map((p) => {
    const out = { ...p }
    for (const k of NUMERIC) out[k] = p[k] === null ? null : Number(p[k])
    return out
  })
}

/** Upsert by month: importing the same (or a corrected) payslip replaces it instead of duplicating. */
export async function savePayslip(p: ParsedPayslip, sha256: string) {
  const t = p.totals
  const r = await supabase.from('payslips').upsert({
    period: `${p.period}-01`, employer: p.employer, pay_date: p.payDate, transfer_date: p.transferDate,
    gross: t.gross, employee_contrib: t.employeeContrib, employer_contrib: t.employerContrib, employer_cost: t.employerCost,
    net_social: t.netSocial, net_before_tax: t.netBeforeTax, net_taxable: t.netTaxable, cumul_taxable: t.cumulTaxable,
    pas_rate: t.pasRate, pas_amount: t.pasAmount, net_paid: t.netPaid,
    lines: p.lines, file_sha256: sha256, updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id,period' })
  if (r.error) throw new Error(r.error.message)
}

export async function deletePayslip(id: string) {
  const r = await supabase.from('payslips').delete().eq('id', id)
  if (r.error) throw new Error(r.error.message)
}
