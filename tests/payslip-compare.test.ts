import { describe, expect, it } from 'vitest'
import { comparePayslips } from '../src/domain/payroll'
import type { PayslipLine } from '../src/parsers/payslipPdf'

const line = (over: Partial<PayslipLine> & { label: string }): PayslipLine => ({
  section: 'Rémunération', code: null, base: null, rate: null, gain: null, deduction: null, employer: null, nonTaxable: false,
  ...over,
})

const totals = (over: Partial<Parameters<typeof comparePayslips>[0]['totals']> = {}) => ({
  gross: null, employee_contrib: null, employer_contrib: null, employer_cost: null,
  net_social: null, net_before_tax: null, net_taxable: null, pas_rate: null, pas_amount: null, net_paid: null,
  ...over,
})

// The real August → September 2026 payslips: gross fell 620,95 € purely because the
// paid-leave regularisation shrank, while base salary, impatriation premium and the car
// benefit were untouched. Take-home fell far more because the PAS rate went 1% → 12,3%.
const agosto = {
  totals: totals({ gross: 15388.61, net_taxable: 7694.1, pas_rate: 1, pas_amount: 76.94, net_paid: 11623.2 }),
  lines: [
    line({ code: '1020', label: 'Base mensuelle', gain: 9167 }),
    line({ code: '1390', label: 'Régul. Congés Payés 07/26', base: 2, gain: 191.06 }),
    line({ code: '1390', label: 'Régul. Congés Payés', base: 5, gain: 477.65 }),
    line({ code: '1669', label: "Prime d'impatriation N.I", gain: 5000 }),
    line({ code: '3026', label: 'Av. nature Voiture', gain: 552.9 }),
    line({ code: '/101', label: 'Salaire Brut', gain: 15388.61 }),
  ],
}
const setembro = {
  totals: totals({ gross: 14767.66, net_taxable: 7180.65, pas_rate: 12.3, pas_amount: 883.22, net_paid: 10321.59 }),
  lines: [
    line({ code: '1020', label: 'Base mensuelle', gain: 9167 }),
    line({ code: '1390', label: 'Régul. Congés Payés 08/26', base: 0.5, gain: 47.76 }),
    line({ code: '1669', label: "Prime d'impatriation N.I", gain: 5000 }),
    line({ code: '3026', label: 'Av. nature Voiture', gain: 552.9 }),
    line({ code: '/101', label: 'Salaire Brut', gain: 14767.66 }),
  ],
}

describe('comparing two payslips', () => {
  it('reports the totals that moved, and only those', () => {
    const { totals: t } = comparePayslips(agosto, setembro)
    const byKey = new Map(t.map((x) => [x.key, x.diff]))
    expect(byKey.get('gross')).toBeCloseTo(-620.95, 2)
    expect(byKey.get('net_paid')).toBeCloseTo(-1301.61, 2)
    expect(byKey.get('pas_rate')).toBeCloseTo(11.3, 2)
    expect(byKey.get('pas_amount')).toBeCloseTo(806.28, 2)
    // Untouched totals are left out instead of listed as zero.
    expect(byKey.has('employer_cost')).toBe(false)
  })

  it('the earning lines add up to the change in gross', () => {
    const { gainDiff, totals: t } = comparePayslips(agosto, setembro)
    const gross = t.find((x) => x.key === 'gross')!.diff
    expect(gainDiff).toBeCloseTo(gross, 2)
    expect(gainDiff).toBeCloseTo(-620.95, 2)
  })

  it('marks a line that only exists on one side', () => {
    const { lines } = comparePayslips(agosto, setembro)
    const saiu = lines.filter((l) => l.status === 'removed').map((l) => l.label)
    const nova = lines.filter((l) => l.status === 'added').map((l) => l.label)
    expect(saiu).toContain('Régul. Congés Payés')
    expect(saiu).toContain('Régul. Congés Payés 07/26')
    expect(nova).toContain('Régul. Congés Payés 08/26')
  })

  it('leaves the untouched lines out entirely', () => {
    const { lines } = comparePayslips(agosto, setembro)
    expect(lines.some((l) => l.label === 'Base mensuelle')).toBe(false)
    expect(lines.some((l) => l.label === "Prime d'impatriation N.I")).toBe(false)
    expect(lines.some((l) => l.label === 'Av. nature Voiture')).toBe(false)
  })

  it('sorts by how big the move was', () => {
    const { lines } = comparePayslips(agosto, setembro)
    const sizes = lines.map((l) => Math.abs(l.diff))
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes)
  })

  it('says nothing changed when the payslips match', () => {
    const { totals: t, lines, gainDiff } = comparePayslips(agosto, agosto)
    expect(t).toEqual([])
    expect(lines).toEqual([])
    expect(gainDiff).toBe(0)
  })

  it('treats a missing side as zero, per column', () => {
    const a = { totals: totals({ gross: 100 }), lines: [line({ code: 'X', label: 'Bônus', gain: 100, employer: 10 })] }
    const b = { totals: totals({ gross: 0 }), lines: [] }
    const { lines } = comparePayslips(a, b)
    expect(lines).toHaveLength(2) // gain and employer both moved
    expect(lines.every((l) => l.status === 'removed')).toBe(true)
    expect(lines.find((l) => l.field === 'gain')!.diff).toBe(-100)
  })
})
