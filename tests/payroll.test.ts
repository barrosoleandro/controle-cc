import { describe, expect, it } from 'vitest'
import type { Row } from '../src/parsers/pdfText'
import { looksLikePayslip, parseFrAmount, parsePayslipRows } from '../src/parsers/payslipPdf'
import { checkContract, DEFAULT_CONTRACT } from '../src/domain/payroll'

// Synthetic payslip that mirrors the real layout (x positions in PDF points, right-aligned numbers). No personal data.
const r = (y: number, ...cells: [number, number, string][]): Row => ({ y, cells: cells.map(([x0, x1, str]) => ({ x0, x1, str })) })
const PAGE: Row[] = [
  r(766, [232, 364, 'BULLETIN DE PAIE']),
  r(748, [256, 314, 'PERIODE DE PAIE'], [323, 366, 'Mai 2026'], [446, 493, 'DATE DE PAIE'], [495, 549, '31.05.2026']),
  r(745, [37, 169, 'ACME Tubes']),
  r(599, [122, 159, 'RUBRIQUE'], [252, 301, 'BASE/HEURES'], [313, 332, 'TAUX'], [347, 350, '*'], [379, 402, 'GAINS'], [441, 478, 'RETENUES'], [495, 563, 'COUT EMPLOYEUR']),
  r(581, [37, 54, '1020'], [58, 117, 'Base mensuelle'], [386, 420, '9.167,00']),
  r(574, [37, 54, '1669'], [58, 159, "Prime d'impatriation N.I"], [386, 420, '5.000,00']),
  r(567, [37, 54, '3026'], [58, 133, 'Av. nature Voiture'], [394, 419, '552,90']),
  r(559, [373, 424, '------------']),
  r(553, [37, 54, '/101'], [58, 108, 'Salaire Brut'], [382, 420, '14.719,90'], [521, 558, '14.719,90']),
  r(517, [37, 58, 'SANTE']),
  r(488, [37, 184, 'Complémentaire prévoyance tranche C'], [264, 302, '1.300,10-'], [315, 336, '0,210'], [471, 492, '2,73-'], [542, 563, '8,32-']),
  r(417, [37, 146, 'Sécurité sociale plafonnée'], [264, 298, '4.005,00'], [315, 336, '6,900'], [463, 488, '276,35'], [533, 558, '342,43']),
  r(295, [37, 234, "CSG/CRDS NON DEDUCTIBLE A L'IMPOT SUR LE REVENU"], [260, 298, '14.536,17'], [315, 336, '2,900'], [346, 350, '*'], [463, 488, '421,55']),
  r(274, [37, 196, 'TOTAL DES COTISATIONS ET CONTRIBUTIONS'], [454, 488, '3.000,29'], [521, 558, '10.243,61']),
  r(267, [37, 150, "TOTAL VERSE PAR L'EMPLOYEUR"], [521, 558, '24.963,51']),
  r(253, [37, 54, '/510'], [58, 133, 'Montant net social'], [260, 298, '11.719,61']),
  r(224, [37, 54, '7526'], [58, 146, 'Ret.Av.nature voiture'], [346, 350, '*'], [463, 488, '552,90']),
  r(198, [34, 227, 'Nous vous recommandons de conserver ce bulletin sans limitation de durée.']),
  r(181, [59, 216, 'NET A PAYER AVANT IMPOT SUR LE REVENU'], [275, 324, '11.166,71']),
  r(139, [34, 183, 'Impôt sur le revenu prélevé à la source'], [276, 319, '7.141,16'], [393, 415, '1,00'], [497, 524, '71,41']),
  r(104, [53, 96, '7.141,16'], [119, 167, '51.942,93'], [244, 273, 'Solde :'], [303, 332, '16,50-']),
  r(66, [297, 329, 'APPOINT'], [425, 472, 'NET A PAYER'], [510, 558, '11.095,30']),
  r(35, [340, 497, 'DATE DE VIREMENT : 27.05.2026']),
]

describe('payslip parser', () => {
  const p = parsePayslipRows([PAGE])
  it('detects and reads header', () => {
    expect(looksLikePayslip([PAGE])).toBe(true)
    expect(p).toMatchObject({ period: '2026-05', payDate: '2026-05-31', transferDate: '2026-05-27', employer: 'ACME Tubes' })
  })
  it('assigns numbers to the right columns', () => {
    expect(p.lines.find((l) => l.code === '1669')).toMatchObject({ gain: 5000, deduction: null })
    expect(p.lines.find((l) => /plafonnée/.test(l.label))).toMatchObject({ section: 'SANTE', base: 4005, rate: 6.9, deduction: 276.35, employer: 342.43 })
    expect(p.lines.find((l) => /tranche C/.test(l.label))).toMatchObject({ base: -1300.1, deduction: -2.73, employer: -8.32 })
    expect(p.lines.find((l) => /CSG/.test(l.label))).toMatchObject({ nonTaxable: true, section: '' })
  })
  it('reads totals, tax and net pay', () => {
    expect(p.totals).toEqual({
      gross: 14719.9, employeeContrib: 3000.29, employerContrib: 10243.61, employerCost: 24963.51, netSocial: 11719.61,
      netBeforeTax: 11166.71, netTaxable: 7141.16, cumulTaxable: 51942.93, pasRate: 1, pasAmount: 71.41, netPaid: 11095.3,
    })
    expect(p.warnings).toEqual([])
  })
  it('parses FR amounts with trailing minus', () => {
    expect(parseFrAmount('1.300,10-')).toBe(-1300.1)
    expect(parseFrAmount('0,048')).toBe(0.048)
  })

  it('checks the contract', () => {
    expect(checkContract(p.lines, DEFAULT_CONTRACT).ok).toBe(true)
    const c = checkContract(p.lines, [...DEFAULT_CONTRACT.slice(1), { code: '1020', label: 'Base', amount: 9500 }, { code: '1740', label: 'Bonus', amount: 1 }])
    expect(c.rows.map((x) => x.status)).toEqual(['ok', 'ok', 'changed', 'missing'])
    expect(c.rows[2].diff).toBe(-333)
    const noPrime = checkContract(p.lines.filter((l) => l.code !== '1669'), DEFAULT_CONTRACT)
    expect(noPrime.rows[1].status).toBe('missing')
  })
})
