import type { Cell, Row } from './pdfText'

/**
 * French "bulletin de paie" (layout used by Vallourec / SAP HR: columns RUBRIQUE, BASE/HEURES,
 * TAUX, GAINS, RETENUES, COUT EMPLOYEUR). Numbers are right-aligned, so each number is assigned
 * to the column whose header ends closest to the number's right edge.
 * Only amounts and labels are kept: SS number, bank account and address are ignored on purpose.
 */
export interface PayslipLine {
  section: string
  code: string | null // payroll code, e.g. '1020' or '/101'; null for contribution lines
  label: string
  base: number | null
  rate: number | null
  gain: number | null
  deduction: number | null
  employer: number | null
  nonTaxable: boolean // '*' = gain not taxable / deduction not tax-deductible
}

export interface PayslipTotals {
  gross: number | null
  employeeContrib: number | null
  employerContrib: number | null
  employerCost: number | null
  netSocial: number | null
  netBeforeTax: number | null
  netTaxable: number | null
  cumulTaxable: number | null
  pasRate: number | null
  pasAmount: number | null
  netPaid: number | null
}

export interface ParsedPayslip {
  period: string // yyyy-mm
  payDate: string | null
  transferDate: string | null
  employer: string
  lines: PayslipLine[]
  totals: PayslipTotals
  warnings: string[]
}

const NUM = /^-?[\d.]+,\d{2,3}-?$/
const MONTHS: Record<string, string> = {
  janvier: '01', fevrier: '02', mars: '03', avril: '04', mai: '05', juin: '06',
  juillet: '07', aout: '08', septembre: '09', octobre: '10', novembre: '11', decembre: '12',
}
type Col = 'base' | 'rate' | 'gain' | 'deduction' | 'employer'

/** '1.300,10-' → -1300.1 ; '9.167,00' → 9167 */
export function parseFrAmount(s: string): number {
  const neg = s.trim().endsWith('-') || s.trim().startsWith('-')
  const n = Number(s.replace(/[-\s]/g, '').replace(/\./g, '').replace(',', '.'))
  if (!Number.isFinite(n)) throw new Error(`Invalid amount: ${s}`)
  return Math.round((neg ? -n : n) * 1000) / 1000
}

const dmyToIso = (s: string) => {
  const m = /(\d{2})\.(\d{2})\.(\d{4})/.exec(s)
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null
}
const text = (cells: Cell[]) => cells.map((c) => c.str).join(' ').replace(/\s+/g, ' ').trim()
const isNum = (c: Cell) => NUM.test(c.str.trim())

export function looksLikePayslip(pages: Row[][]): boolean {
  return pages.some((p) => p.some((r) => /BULLETIN DE PAIE/.test(text(r.cells))))
}

export function parsePayslipRows(pages: Row[][]): ParsedPayslip {
  const lines: PayslipLine[] = []
  const warnings: string[] = []
  const t: PayslipTotals = {
    gross: null, employeeContrib: null, employerContrib: null, employerCost: null, netSocial: null,
    netBeforeTax: null, netTaxable: null, cumulTaxable: null, pasRate: null, pasAmount: null, netPaid: null,
  }
  let period = ''
  let payDate: string | null = null
  let transferDate: string | null = null
  let employer = ''

  for (const rows of pages) {
    const header = rows.find((r) => r.cells.some((c) => c.str.trim() === 'RUBRIQUE'))
    const end = rows.find((r) => /^Nous vous recommandons/.test(text(r.cells)))
    const edge = (re: RegExp) => header?.cells.find((c) => re.test(c.str))?.x1
    const edges: [Col, number | undefined][] = [
      ['base', edge(/BASE/)], ['rate', edge(/TAUX/)], ['gain', edge(/GAINS/)],
      ['deduction', edge(/RETENUES/)], ['employer', edge(/EMPLOYEUR/)],
    ]
    const colOf = (c: Cell): Col => edges.filter((e) => e[1] !== undefined)
      .reduce((best, e) => (Math.abs(e[1]! - c.x1) < Math.abs(best[1]! - c.x1) ? e : best))[0]
    const labelMax = edge(/BASE/) ? edge(/BASE/)! - 50 : 250

    // Header block: period, dates, employer name.
    for (const r of rows) {
      const s = text(r.cells)
      const per = /PERIODE DE PAIE\s+(\S+)\s+(\d{4})/.exec(s)
      if (per) {
        const mm = MONTHS[per[1].normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()]
        if (mm) period = `${per[2]}-${mm}`
      }
      const pd = /DATE DE PAIE\s+(\d{2}\.\d{2}\.\d{4})/.exec(s)
      if (pd) payDate = dmyToIso(pd[1])
      const tr = /DATE DE VIREMENT\s*:\s*(\d{2}\.\d{2}\.\d{4})/.exec(s)
      if (tr) transferDate = dmyToIso(tr[1])
      if (!employer && header && r.y > header.y && r.cells[0]?.x0 < 100 && /^[A-Z]/.test(s) && !/BULLETIN|PERIODE/.test(s)) employer = r.cells[0].str.trim()
    }
    if (!header) continue

    // Body: one row per rubric / contribution.
    let section = ''
    for (const r of rows) {
      if (r.y >= header.y || (end && r.y <= end.y)) continue
      const labelCells = r.cells.filter((c) => !isNum(c) && c.x0 < labelMax)
      const nums = r.cells.filter((c) => isNum(c) && c.x0 >= labelMax - 20)
      const label = text(labelCells)
      if (!label || /^-+$/.test(label)) continue
      if (!nums.length) { section = label; continue }
      const line: PayslipLine = { section, code: null, label, base: null, rate: null, gain: null, deduction: null, employer: null, nonTaxable: r.cells.some((c) => c.str.trim() === '*') }
      const code = /^(\d{4}|\/\d{3})\s+(.*)$/.exec(label)
      if (code) { line.code = code[1]; line.label = code[2] }
      // Coded rubrics, CSG and totals are not part of the contribution section above them.
      if (line.code || /^(TOTAL|CSG|AUTRES)/i.test(line.label)) line.section = ''
      for (const n of nums) line[colOf(n)] = parseFrAmount(n.str)
      lines.push(line)

      const L = line.label.toUpperCase()
      if (line.code === '/101') t.gross = line.gain
      else if (line.code === '/510') t.netSocial = line.base ?? line.gain
      else if (L.startsWith('TOTAL DES COTISATIONS')) { t.employeeContrib = line.deduction; t.employerContrib = line.employer }
      else if (L.startsWith('TOTAL VERSE PAR')) t.employerCost = line.employer
    }

    // Footer: tax and net pay (printed on the last page only).
    for (const r of rows) {
      if (!end || r.y >= end.y) continue
      const s = text(r.cells)
      const nums = r.cells.filter(isNum).map((c) => ({ x1: c.x1, v: parseFrAmount(c.str) }))
      if (/NET A PAYER AVANT IMPOT/.test(s) && nums.length) t.netBeforeTax = nums.at(-1)!.v
      else if (/Impôt sur le revenu prélevé/i.test(s) && nums.length >= 3) { t.pasRate = nums[1].v; t.pasAmount = nums[2].v }
      else if (/APPOINT/.test(s) && /NET A PAYER/.test(s) && nums.length) t.netPaid = nums.at(-1)!.v
      else {
        const left = nums.filter((n) => n.x1 < 200)
        if (left.length === 2) { t.netTaxable = left[0].v; t.cumulTaxable = left[1].v }
      }
    }
  }

  if (!period) throw new Error('Payslip period (PERIODE DE PAIE) not found')
  for (const [k, v] of Object.entries(t)) if (v === null && k !== 'pasRate' && k !== 'pasAmount') warnings.push(`${k} not found`)
  // Self-check: coded earnings must add up to the gross printed by payroll.
  const sumGains = lines.filter((l) => l.code && /^[0-6]/.test(l.code)).reduce((s, l) => s + (l.gain ?? 0), 0)
  if (t.gross !== null && Math.abs(sumGains - t.gross) > 0.01) warnings.push(`earnings ${sumGains.toFixed(2)} ≠ gross ${t.gross.toFixed(2)}`)
  return { period, payDate, transferDate, employer, lines, totals: t, warnings }
}
