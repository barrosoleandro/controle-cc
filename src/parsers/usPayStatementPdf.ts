import { rowsToLines, type Row } from './pdfText'
import type { ParsedPayslip, PayslipLine, PayslipTotals } from './payslipPdf'

/**
 * US "Pay Statement" history (Vallourec USA, "EEPayrollCheckHistory_*.pdf"): one statement per
 * page, paid biweekly, in dollars. Each statement keeps its earnings, deductions and taxes; the
 * statements are then grouped into one payslip per month of the pay date, in USD.
 * Only amounts and labels are kept: SSN, address and bank accounts are ignored on purpose.
 */
export interface UsStatement {
  doc: string // "Document" number + earnings + taxes: the same statement exported twice is recognised by it
  payDate: string // yyyy-mm-dd
  periodStart: string | null
  periodEnd: string | null
  employer: string
  earnings: { label: string; hours: number | null; amount: number }[]
  deductions: { label: string; employee: number; employer: number }[]
  taxes: { label: string; amount: number }[]
  /** Printed "Pay Summary" (absent on off-cycle statements such as share vesting). */
  summary: { gross: number; taxable: number; taxes: number; deductions: number; net: number } | null
  netPay: number
}

const MONEY = /\(?-?\$[\d,]+\.\d{2}\)?/g
/** '$1,634.89' → 1634.89 ; '($1,176.92)' → -1176.92 */
export function parseUsd(s: string): number {
  const neg = /^\(.*\)$/.test(s.trim()) || s.includes('-')
  const n = Number(s.replace(/[()$,\s-]/g, ''))
  if (!Number.isFinite(n)) throw new Error(`Invalid amount: ${s}`)
  return neg ? -n : n
}
const money = (s: string) => (s.match(MONEY) ?? []).map(parseUsd)
const mdyToIso = (s: string) => {
  const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(s)
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null
}
const cents = (v: number) => Math.round(v * 100) / 100
/** Text before the first number or amount: the row's label. */
const labelOf = (l: string) => l.split(/\s{3}/)[0].trim()

export function looksLikeUsPayStatement(pages: Row[][]): boolean {
  const lines = rowsToLines(pages.slice(0, 1))
  return lines.some((l) => /^Pay Statement$/.test(l.trim())) && lines.some((l) => /Period End Date/.test(l))
}

/** One statement from its text lines (those between two "Pay Statement" titles). */
function parseStatement(lines: string[]): UsStatement {
  const find = (re: RegExp) => { for (const l of lines) { const m = re.exec(l); if (m) return m[1] } return null }
  const payDate = mdyToIso(find(/Pay Date\s+(\d{2}\/\d{2}\/\d{4})/) ?? '')
  if (!payDate) throw new Error('US pay statement without "Pay Date"')
  const st: UsStatement = {
    doc: find(/Document\s+(\S+)/) ?? payDate,
    payDate,
    periodStart: mdyToIso(find(/Period Start Date\s+(\S+)/) ?? ''),
    periodEnd: mdyToIso(find(/Period End Date\s+(\S+)/) ?? ''),
    employer: lines.flatMap((l) => l.split(/\s{3}/)).map((x) => x.trim())
      .find((x) => /\b(Corporation|Corp\.?|Inc\.?|LLC|Company)$/.test(x) && !/^Pay Group/.test(x)) ?? 'Empregador (EUA)',
    earnings: [], deductions: [], taxes: [], summary: null, netPay: 0,
  }

  let section: 'earn' | 'ded' | 'tax' | 'sum' | null = null
  let earnHasYtd = false
  for (const l of lines) {
    const t = l.trim()
    if (/^Pay Type\s+Hours/.test(t)) { section = 'earn'; earnHasYtd = /\bYTD\b/.test(t); continue }
    if (/^Deduction\s+Pre-Tax/.test(t)) { section = 'ded'; continue }
    if (/^Tax\s+Current\s+YTD/.test(t)) { section = 'tax'; continue }
    if (/^Gross\s+FIT Taxable/.test(t)) { section = 'sum'; continue }
    if (/^(Total Hours|Deductions$|Taxes$|Paid Time Off|Account Number|Pay Summary|vsn )/.test(t)) { section = null; continue }
    if (!section) continue
    const amounts = money(t)
    if (section === 'earn' && amounts.length) {
      const label = labelOf(t)
      const hours = /^\S.*?\s{3}(-?\d+\.\d+)\s{3}/.exec(t)
      st.earnings.push({ label, hours: hours ? Number(hours[1]) : null, amount: earnHasYtd ? amounts.at(-2) ?? 0 : amounts.at(-1)! })
    } else if (section === 'ded' && amounts.length >= 3) {
      st.deductions.push({ label: labelOf(t), employee: amounts[0], employer: amounts[2] })
    } else if (section === 'tax' && amounts.length) {
      st.taxes.push({ label: labelOf(t), amount: amounts[0] })
    } else if (section === 'sum' && /^Current\b/.test(t) && amounts.length >= 5) {
      const [gross, taxable, taxes, deductions, net] = amounts
      st.summary = { gross, taxable, taxes, deductions, net }
    }
  }
  // "Net Pay   $x" sits beside the address, or the amount lands on the line above "Net Pay".
  const i = lines.findIndex((l) => /^Net Pay\b/.test(l.trim()))
  const inline = i >= 0 ? money(lines[i]) : []
  st.netPay = st.summary?.net ?? inline[0] ?? (i > 0 ? money(lines[i - 1]).at(-1) ?? 0 : 0)
  // Off-cycle statements of the same day can share a document number (seen: two "12202024"
  // with different amounts), so the amounts are part of the key.
  const total = (xs: { amount: number }[]) => cents(xs.reduce((s, x) => s + x.amount, 0)).toFixed(2)
  st.doc = `${st.doc}|${total(st.earnings)}|${total(st.taxes)}`
  return st
}

/** All statements of the file, each once (the export repeats nothing, but two files can overlap). */
export function parseUsStatements(pages: Row[][]): UsStatement[] {
  const lines = rowsToLines(pages)
  const out = new Map<string, UsStatement>()
  let cur: string[] | null = null
  const flush = () => { if (cur) { const s = parseStatement(cur); out.set(s.doc, s) } }
  for (const l of lines) {
    if (/^Pay Statement$/.test(l.trim())) { flush(); cur = [] } else cur?.push(l)
  }
  flush()
  return [...out.values()]
}

const BR = (iso: string) => iso.split('-').reverse().join('/')

/** The statement as payslip lines; zero lines (the export lists every pay type) are left out. */
export function statementLines(s: UsStatement): PayslipLine[] {
  const base = { code: null, base: null, rate: null, gain: null, deduction: null, employer: null, nonTaxable: false, doc: s.doc, payDate: s.payDate }
  const head = `Pago em ${BR(s.payDate)}`
  return [
    ...s.earnings.filter((e) => e.amount !== 0).map((e): PayslipLine => ({ ...base, section: `${head} · Ganhos`, label: e.label, gain: e.amount })),
    ...s.deductions.filter((d) => d.employee !== 0 || d.employer !== 0).map((d): PayslipLine => ({ ...base, section: `${head} · Descontos`, label: d.label, deduction: d.employee || null, employer: d.employer || null })),
    ...s.taxes.filter((t) => t.amount !== 0).map((t): PayslipLine => ({ ...base, section: `${head} · Impostos`, label: t.label, deduction: t.amount })),
  ]
}

const isTax = (l: PayslipLine) => l.section.endsWith('· Impostos')
const isEarning = (l: PayslipLine) => l.section.endsWith('· Ganhos')

/**
 * One month of US pay from its statement lines: totals are recomputed from the lines, so
 * statements of the same month coming from different files can be merged by document number.
 */
export function usMonth(period: string, lines: PayslipLine[], employer: string): ParsedPayslip {
  const sorted = [...lines].sort((a, b) => (a.payDate ?? '').localeCompare(b.payDate ?? '') || (a.doc ?? '').localeCompare(b.doc ?? ''))
  const sum = (f: (l: PayslipLine) => boolean, k: 'gain' | 'deduction' | 'employer') => cents(sorted.filter(f).reduce((s, l) => s + (l[k] ?? 0), 0))
  const gross = sum(isEarning, 'gain')
  const taxes = sum(isTax, 'deduction')
  const deductions = sum((l) => !isTax(l) && !isEarning(l), 'deduction')
  const t: PayslipTotals = {
    gross, employeeContrib: deductions, employerContrib: sum(() => true, 'employer'), employerCost: null,
    netSocial: null, netBeforeTax: cents(gross - deductions), netTaxable: null, cumulTaxable: null,
    pasRate: null, pasAmount: taxes, netPaid: cents(gross - deductions - taxes),
  }
  const dates = sorted.map((l) => l.payDate!).filter(Boolean)
  return { period, payDate: dates.at(-1) ?? null, transferDate: null, employer, lines: sorted, totals: t, warnings: [], currency: 'USD' }
}

/** Statements grouped by the month they were paid in (yyyy-mm), with self-checks against the printed summary. */
export function usPayslipsByMonth(statements: UsStatement[]): ParsedPayslip[] {
  const byMonth = new Map<string, UsStatement[]>()
  for (const s of statements) byMonth.set(s.payDate.slice(0, 7), [...(byMonth.get(s.payDate.slice(0, 7)) ?? []), s])
  return [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([period, list]) => {
    const p = usMonth(period, list.flatMap(statementLines), list[0].employer)
    for (const s of list) {
      const gross = cents(s.earnings.reduce((x, e) => x + e.amount, 0))
      const net = cents(gross - s.deductions.reduce((x, d) => x + d.employee, 0) - s.taxes.reduce((x, d) => x + d.amount, 0))
      if (s.summary && Math.abs(gross - s.summary.gross) > 0.01) p.warnings.push(`${BR(s.payDate)}: ganhos ${gross.toFixed(2)} ≠ gross ${s.summary.gross.toFixed(2)}`)
      if (Math.abs(net - s.netPay) > 0.01) p.warnings.push(`${BR(s.payDate)}: líquido calculado ${net.toFixed(2)} ≠ net pay ${s.netPay.toFixed(2)}`)
    }
    return p
  })
}

/** Adds the statements of `incoming` to an already saved month, keeping the ones only the saved month has. */
export function mergeUsMonth(saved: PayslipLine[], incoming: ParsedPayslip): ParsedPayslip {
  const docs = new Set(incoming.lines.map((l) => l.doc))
  const kept = saved.filter((l) => l.doc && !docs.has(l.doc))
  return { ...usMonth(incoming.period, [...kept, ...incoming.lines], incoming.employer), warnings: incoming.warnings }
}
