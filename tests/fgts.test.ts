import { describe, expect, it } from 'vitest'
import { checkFgts, depositsByMonth, parseFgtsExtract } from '../src/domain/fgts'

describe('FGTS de expatriado', () => {
  it('esperado = 8% do bruto francês em reais, pela taxa do dia do pagamento', () => {
    const c = checkFgts([
      { period: '2026-09-01', gross: 10000, pay_date: '2026-09-30' },
      { period: '2026-10-01', gross: 10000, pay_date: null },
      { period: '2026-08-01', gross: null, pay_date: null },
    ], { '2026-09': 2000, '2025-05': 900 }, (_c, d) => (d === '2026-09-30' ? 6 : 6.5))
    expect(c.rows.map((r) => [r.competencia, r.baseBrl, r.esperado, r.depositado, r.diferenca])).toEqual([
      ['2026-09', 60000, 4800, 2000, -2800],
      ['2026-10', 65000, 5200, null, null],
    ])
    expect(c.rows[0].baseImplicita).toBe(25000)
    expect(c.rows[1].dataTaxa).toBe('2026-10-31')
    expect(c).toMatchObject({ esperado: 10000, depositado: 2000, diferenca: -8000, semDeposito: ['2026-10'], outros: [{ competencia: '2025-05', valor: 900 }] })
  })

  it('lê os depósitos do extrato e deixa JAM e saque de fora', () => {
    const d = parseFgtsExtract([
      'DATA   LANÇAMENTO   VALOR   TOTAL',
      '07/11/2025   115-DEPÓSITO OUTUBRO/2025   R$ 2.345,67   R$ 98.765,43',
      '10/11/2025   CREDITO DE JAM 0,002466   R$ 243,10   R$ 99.008,53',
      '05/12/2025   DEP. COMP. 11/2025   1.200,00   100.208,53',
      '19/12/2025   DEPOSITO 13 SALARIO DEZ/25   800,00   101.008,53',
      '06/01/2026   DEPOSITO   1.250,00   102.258,53',
      '06/01/2026   DEPOSITO COMPLEMENTAR OUT/2025   100,00   102.358,53',
      '15/02/2026   SAQUE ANIVERSARIO   -500,00   101.858,53',
    ])
    expect(d.map((x) => [x.competencia, x.valor, x.inferida])).toEqual([
      ['2025-10', 2345.67, false], ['2025-11', 1200, false], ['2025-13', 800, false], ['2025-12', 1250, true], ['2025-10', 100, false],
    ])
    expect(depositsByMonth(d)['2025-10']).toBe(2445.67)
  })
})
