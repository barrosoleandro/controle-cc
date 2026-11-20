import { describe, expect, it } from 'vitest'
import type { Row } from '../src/parsers/pdfText'
import { looksLikeUsPayStatement, mergeUsMonth, parseUsd, parseUsStatements, usPayslipsByMonth } from '../src/parsers/usPayStatementPdf'
import { looksLikePayslip } from '../src/parsers/payslipPdf'
import { checkFgts, usCashParts } from '../src/domain/fgts'

// Synthetic statements in the layout of the US "Pay Statement" export. No personal data.
const page = (text: string): Row[] => text.trim().split('\n').map((l, i) => {
  let x = 20
  return { y: 800 - i * 12, cells: l.trim().split('   ').map((str) => { const c = { x0: x, x1: x + str.length * 5, str }; x = c.x1 + 15; return c }) }
})
const regular = (date: string, doc: string, gross: string, extra = '') => page(`
Pay Statement
Period Start Date 01/01/2024
ACME USA Corporation   Period End Date   01/14/2024
Pay Date   ${date}
Document   ${doc}
Net Pay
Pay Details
Jane Doe   Employee Number 1   Pay Group USA Corp Salary
Earnings
Pay Type   Hours   Pay Rate   Current   YTD
Holiday   0.000000   $0.00   $0.00   $0.00
Regular Pay   80.000000   $0.00   ${gross}   $9,999.00
${extra}Total Hours 80.000000
Deductions
Deduction   Pre-Tax   Employee Current   Employee YTD   Employer Current   Employer YTD
Housing Allow   No   ($1,000.00)   ($2,000.00)   $0.00   $0.00
Miscellaneous   No   $100.00   $200.00   $0.00   $0.00
Taxes
Tax   Current   YTD
Federal Income Tax   $400.00   $800.00
Paid Time Off   Net Pay Distribution
Account Number   Account Type   Amount
xxxx1234   Checking   $5,500.00
Pay Summary
Gross   FIT Taxable Wages   Taxes   Deductions   Net Pay
Current   $5,000.00   $5,000.00   $400.00   ($900.00)   $5,500.00
YTD   $10,000.00   $10,000.00   $800.00   ($1,800.00)   $11,000.00
vsn 20180731`)
const vesting = (date: string, doc: string, amount: string) => page(`
Pay Statement
Period Start Date 12/01/2024
ACME USA Corporation   Period End Date   12/14/2024
Pay Date   ${date}
Document   ${doc}
Net Pay   $0.00
Earnings
Pay Type   Hours   Pay Rate   Current
Share Vesting   0.000000   $0.00   ${amount}
Total Hours 0.000000
Deductions
Deduction   Pre-Tax   Employee Current   Employee YTD   Employer Current   Employer YTD
Miscellaneous   No   $800.00   $800.00   $0.00   $0.00
Taxes
Tax   Current   YTD
Federal Income Tax   $200.00   $200.00
Paid Time Off   Net Pay Distribution
Account Number   Account Type   Amount
No records found
vsn 20180731`)

describe('US pay statements', () => {
  it('reads amounts in dollars, parentheses are negative', () => {
    expect(parseUsd('$12,974.79')).toBe(12974.79)
    expect(parseUsd('($1,176.92)')).toBe(-1176.92)
  })

  it('detects the export and not as a French bulletin', () => {
    const pages = [regular('01/12/2024', '100', '$5,000.00')]
    expect(looksLikeUsPayStatement(pages)).toBe(true)
    expect(looksLikePayslip(pages)).toBe(false)
  })

  it('groups biweekly statements by month and checks them against the printed summary', () => {
    const st = parseUsStatements([regular('01/12/2024', '100', '$5,000.00'), regular('01/26/2024', '101', '$5,000.00'), vesting('02/09/2024', '102', '$1,000.00')])
    expect(st.map((s) => [s.payDate, s.employer, s.netPay])).toEqual([['2024-01-12', 'ACME USA Corporation', 5500], ['2024-01-26', 'ACME USA Corporation', 5500], ['2024-02-09', 'ACME USA Corporation', 0]])
    const months = usPayslipsByMonth(st)
    expect(months.map((m) => [m.period, m.currency, m.totals.gross, m.totals.pasAmount, m.totals.netPaid, m.warnings])).toEqual([
      ['2024-01', 'USD', 10000, 800, 11000, []],
      ['2024-02', 'USD', 1000, 200, 0, []],
    ])
    // Zero lines (Holiday $0.00) are left out; no bank account is kept.
    expect(months[0].lines.map((l) => l.label)).toEqual(['Regular Pay', 'Housing Allow', 'Miscellaneous', 'Federal Income Tax', 'Regular Pay', 'Housing Allow', 'Miscellaneous', 'Federal Income Tax'])
    expect(JSON.stringify(months)).not.toContain('1234')
  })

  it('reads the earnings current amount with and without the YTD column', () => {
    const [s] = parseUsStatements([regular('01/12/2024', '100', '$5,000.00', 'VBP Bonus   $2,000.00   $2,000.00\n')])
    expect(s.earnings.map((e) => [e.label, e.amount])).toEqual([['Holiday', 0], ['Regular Pay', 5000], ['VBP Bonus', 2000]])
  })

  it('keeps two statements that share a document number but not the amounts', () => {
    expect(parseUsStatements([vesting('12/20/2024', '12202024', '$1,000.00'), vesting('12/20/2024', '12202024', '$2,000.00')])).toHaveLength(2)
  })

  it('merges a month split across two files, each statement once', () => {
    const [a] = usPayslipsByMonth(parseUsStatements([regular('01/12/2024', '100', '$5,000.00')]))
    const [b] = usPayslipsByMonth(parseUsStatements([regular('01/12/2024', '100', '$5,000.00'), regular('01/26/2024', '101', '$5,000.00')]))
    const merged = mergeUsMonth(a.lines, b)
    expect(merged.totals.gross).toBe(10000)
    expect(mergeUsMonth(merged.lines, a).totals.gross).toBe(10000)
  })

  it('FGTS: only cash pay in the base, in reais by the rate of each pay day, added to the French month', () => {
    const [jan] = usPayslipsByMonth(parseUsStatements([regular('01/12/2024', '100', '$5,000.00'), regular('01/26/2024', '101', '$5,000.00'), vesting('01/26/2024', '102', '$1,000.00')]))
    expect(usCashParts(jan.lines).map((p) => [p.amount, p.excluded])).toEqual([[5000, 0], [5000, 0], [0, 1000]])
    const c = checkFgts([
      { period: '2024-01-01', gross: jan.totals.gross, pay_date: jan.payDate, currency: 'USD', lines: jan.lines },
      { period: '2024-01-01', gross: 1000, pay_date: '2024-01-31', currency: 'EUR' },
    ], {}, (cur, d) => (cur === 'EUR' ? 6 : d === '2024-01-12' ? 5 : 4))
    expect(c.rows).toHaveLength(1)
    expect(c.rows[0]).toMatchObject({ competencia: '2024-01', bruto: { USD: 10000, EUR: 1000 }, foraDaBase: 1000, taxa: null, baseBrl: 51000, esperado: 4080 })
  })

  it('FGTS: a month with no USD rate is flagged, not silently zero', () => {
    const [jan] = usPayslipsByMonth(parseUsStatements([regular('01/12/2024', '100', '$5,000.00')]))
    const c = checkFgts([{ period: '2024-01-01', gross: jan.totals.gross, pay_date: jan.payDate, currency: 'USD', lines: jan.lines }], {}, () => null)
    expect(c.rows[0]).toMatchObject({ semTaxa: true, baseBrl: 0, taxa: null })
  })
})
