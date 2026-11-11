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

import { looksLikeFgtsExtract } from '../src/domain/fgts'
import { parseStatement } from '../src/parsers'
describe('extrato completo da Caixa (app FGTS)', () => {
  const lines = [
    'EMPREGADOR   DATA DE ADMISSÃO   PIS/PASEP',
    'TIPO DE CONTA   TAXA DE JUROS   VALOR PARA FINS RESCISÓRIOS',
    'OPTANTE   3.0% a.a   R$ 50.000,00',
    'DATA   LANÇAMENTO   VALOR   TOTAL',
    'SALDO ANTERIOR   0,00   0,00',
    '05/03/2004   115-DEPOSITO FEVEREIRO 2004   R$ 400,00   R$ 400,00',
    '10/04/2004   CREDITO DE JAM 0,004248   R$ 1,82   R$ 401,82',
    '25/05/2017   TRANSFERENCIA EXPEDIDA - DEP BH   -R$ 300,00   R$ 101,82',
    '15/06/2020   TRANSFERENCIA RECEBIDA - DEP BH   R$ 6.000,00   R$ 6.101,82',
    '06/04/2020   AC REPOSICAO DEP EM 22/11/2019   R$ 486,87   R$ 6.588,69',
    '07/07/2020   115-DEPOSITO EM ATRASO MARCO 2020   R$ 1.827,84   R$ 8.416,53',
    '04/09/2020   115-JAM RECOLHIDO EMPRESA ABRIL 2020   R$ 13,53   R$ 8.430,06',
    '17/07/2008   SAQUE DEP COD 99 539120910789926   -R$ 1.000,00   R$ 7.430,06',
    '20/10/2026   115-DEPOSITO SETEMBRO 2026   R$ 3.061,36   R$ 10.491,42',
  ]
  it('is recognised', () => {
    expect(looksLikeFgtsExtract(lines)).toBe(true)
    expect(looksLikeFgtsExtract(['DATA   LANÇAMENTO   VALOR', '05/03/2026   PIX ENVIADO   -10,00'])).toBe(false)
  })
  it('keeps only employer deposits: no transfers between FGTS accounts, reversals or withdrawals', () => {
    expect(parseFgtsExtract(lines).map((d) => [d.competencia, d.valor, d.inferida])).toEqual([
      ['2004-02', 400, false], ['2020-03', 1827.84, false], ['2026-09', 3061.36, false],
    ])
  })
  it('the Importar screen routes it instead of rejecting the PDF', async () => {
    // parseStatement only needs the PDF text: a fake loader with one text item per line.
    const page = { getTextContent: async () => ({ items: lines.map((str, i) => ({ str, transform: [1, 0, 0, 1, 10, 800 - i * 20], width: str.length * 5 })) }) }
    const load = (() => Promise.resolve({ numPages: 1, getPage: async () => page })) as never
    const res = await parseStatement('EXTRATO_EMPRESA.pdf', new Uint8Array(), load)
    expect(res.source).toBe('ignored')
    expect(res.fgts?.map((d) => d.competencia)).toEqual(['2004-02', '2020-03', '2026-09'])
  })
})
