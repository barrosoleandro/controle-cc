import { describe, expect, it } from 'vitest'
import { anosCompletos, avos13, avosFerias, calcularPrevidencia, calcularRescisao, diasAviso, inss, irrf, novaPrevidencia, novaRescisao, type RescisaoInput } from '../src/domain/rescisao'

const base = (o: Partial<RescisaoInput> = {}): RescisaoInput => ({
  ...novaRescisao(10000), admissao: '2020-03-10', desligamento: '2026-10-31', ...o,
})

describe('rescisão CLT', () => {
  it('conta anos, aviso e avos', () => {
    expect(anosCompletos('2020-03-10', '2026-10-31')).toBe(6)
    expect(anosCompletos('2020-03-10', '2021-03-08')).toBe(0)
    expect(anosCompletos('2020-03-10', '2021-03-09')).toBe(1)
    expect(diasAviso('2020-03-10', '2026-10-31')).toBe(48)
    expect(diasAviso('2000-01-01', '2026-10-31')).toBe(90)
    expect(avos13('2026-02-20', '2026-10-31')).toBe(8) // fevereiro: 9 dias, não conta
    expect(avosFerias('2020-03-10', '2026-12-18')).toBe(9)
  })

  it('INSS progressivo com teto e IR com a isenção até 5 mil', () => {
    expect(inss(10000)).toBe(inss(8475.55))
    expect(inss(1621)).toBeCloseTo(121.58, 2)
    expect(irrf(5000, 607.2)).toBe(0)
    expect(irrf(10000, 988.09)).toBeCloseTo(1569.55, 2)
  })

  it('dispensa sem justa causa com aviso indenizado', () => {
    const r = calcularRescisao(base({ saldoFgts: 50000 }))
    expect(r.diasAvisoPagos).toBe(48)
    expect(r.fimProjetado).toBe('2026-12-18')
    expect(r.avos13).toBe(12)
    expect(r.avosFerias).toBe(9)
    expect(r.bruto).toBeCloseTo(10000 + 16000 + 10000 + 7500 + 2500, 2)
    // depósito de 8% sobre saldo, aviso e 13º; multa de 40% sobre a conta inteira
    expect(r.fgts.deposito).toBeCloseTo(2880, 2)
    expect(r.fgts.multa).toBeCloseTo(0.4 * 52880, 2)
    expect(r.fgts.sacavel).toBeCloseTo(52880 * 1.4, 2)
    expect(r.total).toBeCloseTo(r.liquido + r.fgts.sacavel, 2)
  })

  it('acordo paga metade do aviso, multa de 20% e saque de 80%', () => {
    const r = calcularRescisao(base({ tipo: 'acordo', saldoFgts: 50000 }))
    expect(r.diasAvisoPagos).toBe(24)
    expect(r.fgts.multaPct).toBe(0.2)
    const conta = 50000 + r.fgts.deposito
    expect(r.fgts.sacavel).toBeCloseTo(conta * 0.8 + conta * 0.2, 2)
    expect(r.fgts.ficaNaConta).toBeCloseTo(conta * 0.2, 2)
  })

  it('multa sobre o saldo para fins rescisórios; saque do saldo atual', () => {
    // 30 mil já sacados durante o contrato: a conta tem 50 mil, mas os depósitos somam 80 mil
    const r = calcularRescisao(base({ saldoFgts: 50000, baseMultaFgts: 80000 }))
    expect(r.fgts.baseMulta).toBeCloseTo(82880, 2)
    expect(r.fgts.multa).toBeCloseTo(0.4 * 82880, 2)
    expect(r.fgts.sacavel).toBeCloseTo(52880 + 0.4 * 82880, 2)
  })

  it('saque-aniversário: na dispensa só a multa é sacada', () => {
    const r = calcularRescisao(base({ saldoFgts: 50000, saqueAniversario: true }))
    expect(r.fgts.sacavel).toBeCloseTo(r.fgts.multa, 2)
    expect(r.fgts.ficaNaConta).toBeCloseTo(52880, 2)
  })

  it('previdência: vesting da parte da empresa, IR do PGBL e do VGBL, e entra no total só se resgatar', () => {
    const p = { ...novaPrevidencia(), suas: 100000, empresa: 80000, vestingPct: 50 }
    const pgbl = calcularPrevidencia(p)
    expect(pgbl.bruto).toBe(140000)
    expect(pgbl.perdido).toBe(40000)
    expect(pgbl.ir).toBeCloseTo(21000, 2) // 15% na fonte sobre tudo
    const vgbl = calcularPrevidencia({ ...p, plano: 'VGBL', aportado: 120000, regime: 'regressivo', aliquota: 0.1 })
    expect(vgbl.base).toBe(20000)
    expect(vgbl.ir).toBeCloseTo(2000, 2)
    const com = calcularRescisao(base({ previdencia: p }))
    const sem = calcularRescisao(base({ previdencia: { ...p, resgatar: false } }))
    expect(com.total - sem.total).toBeCloseTo(pgbl.liquido, 2)
    expect(calcularRescisao(base()).previdencia).toBeNull()
  })

  it('pedido de demissão sem cumprir aviso desconta um salário e não saca FGTS', () => {
    const r = calcularRescisao(base({ tipo: 'pedido', aviso: 'nao_cumprido', saldoFgts: 50000 }))
    expect(r.diasAvisoPagos).toBe(0)
    expect(r.descontos.find((d) => d.label.startsWith('Aviso'))?.valor).toBe(10000)
    expect(r.fgts.sacavel).toBe(0)
    expect(r.fgts.multa).toBe(0)
  })

  it('justa causa: só saldo de salário e férias vencidas', () => {
    const r = calcularRescisao(base({ tipo: 'justa_causa', feriasVencidas: 1 }))
    expect(r.verbas.map((v) => v.label)).toEqual(['Saldo de salário (30 dias)', 'Férias vencidas (1 período(s))', '1/3 das férias vencidas'])
  })
})
