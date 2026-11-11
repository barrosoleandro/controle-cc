import type { PayCurrency, PayslipLine } from '../parsers/payslipPdf'

/**
 * FGTS de expatriado (CLT ativa, transferido, Lei 7.064/82, art. 3º, parágrafo único): os 8% incidem
 * sobre a remuneração total, inclusive a paga no exterior. O esperado de cada competência vem do
 * bruto dos holerites (França em euros, EUA em dólares) convertido em reais; o depositado vem do
 * extrato do FGTS (app FGTS).
 */
export const FGTS_RATE = 0.08

export interface FgtsPayslip { period: string; gross: number | null; pay_date: string | null; currency?: PayCurrency; lines?: PayslipLine[] }
export interface FgtsRow {
  competencia: string // yyyy-mm
  bruto: Partial<Record<PayCurrency, number>> // na base, por moeda
  /** Ganhos sem dinheiro dos contracheques dos EUA (Share Vesting, Fringe…), fora da base, em US$. */
  foraDaBase: number
  taxa: number | null // cotação usada (média ponderada se houve vários pagamentos); null se misturou moedas
  dataTaxa: string // último pagamento da competência
  semTaxa: boolean // faltou a cotação de algum pagamento: base incompleta
  baseBrl: number
  esperado: number
  depositado: number | null
  diferenca: number | null // depositado − esperado
  baseImplicita: number | null // depositado ÷ 8%: a remuneração sobre a qual a empresa depositou
}
export interface FgtsCheck {
  rows: FgtsRow[]
  esperado: number
  depositado: number
  diferenca: number
  semDeposito: string[]
  /** Depósitos de competências sem holerite (ex.: antes de ir para fora, ou 13º). */
  outros: { competencia: string; valor: number }[]
}

const round = (v: number) => Math.round(v * 100) / 100
const lastDay = (ym: string) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}` }

/** One payment that enters the FGTS base: amount, currency, the day of the rate, and what was left out. */
interface Part { currency: PayCurrency; amount: number; date: string; excluded: number }

/**
 * The cash pay of each US statement. Earnings with no money behind them are left out: share
 * vesting, and amounts the statement takes back as a deduction of the same name and value
 * (Auto Allowance, Gift / Prize) or that leave the statement with no net pay (yearly Fringe).
 */
export function usCashParts(lines: PayslipLine[]): Part[] {
  const byDoc = new Map<string, PayslipLine[]>()
  for (const l of lines) byDoc.set(l.doc ?? l.payDate ?? '', [...(byDoc.get(l.doc ?? l.payDate ?? '') ?? []), l])
  return [...byDoc.values()].map((ls) => {
    const earn = ls.filter((l) => l.section.endsWith('· Ganhos'))
    const ded = ls.filter((l) => !l.section.endsWith('· Ganhos'))
    const gross = earn.reduce((s, l) => s + (l.gain ?? 0), 0)
    const net = gross - ded.reduce((s, l) => s + (l.deduction ?? 0), 0)
    const nonCash = (l: PayslipLine) => net < 0.01 || /share vesting/i.test(l.label)
      || ded.some((d) => d.label === l.label && Math.abs((d.deduction ?? 0) - (l.gain ?? 0)) < 0.01)
    const cash = round(earn.filter((l) => !nonCash(l)).reduce((s, l) => s + (l.gain ?? 0), 0))
    return { currency: 'USD' as const, amount: cash, date: ls[0].payDate ?? '', excluded: round(gross - cash) }
  })
}

/**
 * `toBrl(currency, date)`: the rate of that day, or null when it is not known. The pay date is used;
 * without one, the last day of the month. Payslips of the same month (a French one and US
 * statements in the transfer month) add up in one competência.
 */
export function checkFgts(payslips: FgtsPayslip[], deposits: Record<string, number>, toBrl: (currency: PayCurrency, date: string) => number | null): FgtsCheck {
  const parts = new Map<string, Part[]>()
  for (const p of payslips) {
    const competencia = p.period.slice(0, 7)
    const list = p.currency === 'USD'
      ? usCashParts(p.lines ?? [])
      : p.gross && p.gross > 0 ? [{ currency: 'EUR' as const, amount: p.gross, date: p.pay_date ?? lastDay(competencia), excluded: 0 }] : []
    parts.set(competencia, [...(parts.get(competencia) ?? []), ...list])
  }
  const rows = [...parts.entries()].filter(([, ps]) => ps.some((x) => x.amount > 0)).map(([competencia, ps]): FgtsRow => {
    const bruto: Partial<Record<PayCurrency, number>> = {}
    let baseBrl = 0, semTaxa = false
    for (const x of ps) {
      if (x.amount <= 0) continue
      bruto[x.currency] = round((bruto[x.currency] ?? 0) + x.amount)
      const r = toBrl(x.currency, x.date)
      if (r === null) semTaxa = true; else baseBrl += x.amount * r
    }
    baseBrl = round(baseBrl)
    const moedas = Object.keys(bruto) as PayCurrency[]
    const esperado = round(baseBrl * FGTS_RATE)
    const dep = deposits[competencia]
    const depositado = dep === undefined ? null : dep
    return {
      competencia, bruto, foraDaBase: round(ps.reduce((s, x) => s + x.excluded, 0)),
      taxa: moedas.length === 1 && !semTaxa ? Math.round((baseBrl / bruto[moedas[0]]!) * 10000) / 10000 : null,
      dataTaxa: ps.map((x) => x.date).sort().at(-1)!, semTaxa, baseBrl, esperado, depositado,
      diferenca: depositado === null ? null : round(depositado - esperado), baseImplicita: depositado === null ? null : round(depositado / FGTS_RATE),
    }
  }).sort((a, b) => a.competencia.localeCompare(b.competencia))
  const mine = new Set(rows.map((r) => r.competencia))
  const esperado = round(rows.reduce((s, r) => s + r.esperado, 0))
  const depositado = round(rows.reduce((s, r) => s + (r.depositado ?? 0), 0))
  return {
    rows, esperado, depositado, diferenca: round(depositado - esperado),
    semDeposito: rows.filter((r) => r.depositado === null).map((r) => r.competencia),
    outros: Object.entries(deposits).filter(([c]) => !mine.has(c)).map(([competencia, valor]) => ({ competencia, valor })).sort((a, b) => a.competencia.localeCompare(b.competencia)),
  }
}

const MESES = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ']
const AMOUNT = /(?<![\d,])-?\d{1,3}(?:\.\d{3})*,\d{2}(?![\d])/g
const brNumber = (s: string) => Number(s.replace(/\./g, '').replace(',', '.'))
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
const prevMonth = (ym: string) => { const [y, m] = ym.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}` }

export interface FgtsDeposit { competencia: string; valor: number; linha: string; /** Sem competência escrita: o mês anterior ao do lançamento (o depósito vence até o dia 20 do mês seguinte). */ inferida: boolean }

/**
 * Depósitos do extrato do FGTS (texto do PDF, uma linha por lançamento). Fica só com as linhas
 * de depósito: créditos de JAM (juros e correção), saques e estornos ficam de fora. A competência
 * vem do texto ("OUTUBRO/2025", "OUT/25", "10/2025"); sem ela, do mês anterior ao lançamento.
 * O valor é o primeiro valor em reais depois da descrição (o seguinte costuma ser o saldo).
 */
export function parseFgtsExtract(lines: string[]): FgtsDeposit[] {
  const out: FgtsDeposit[] = []
  for (const raw of lines) {
    const l = fold(raw)
    // Only what the employer deposited: money moved between FGTS accounts (TRANSFERENCIA … DEP),
    // a withdrawal put back (AC REPOSICAO DEP) and any debit (-R$) are not deposits.
    if (!/\bDEP/.test(l) || /JAM|SAQUE|ESTORNO|SALDO ANTERIOR|TOTAL|TRANSFERENCIA|REPOSICAO|REGULARIZACAO|-\s*R\$/.test(l)) continue
    const date = l.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/)
    let rest = date ? l.replace(date[0], ' ') : l
    let competencia: string | null = null
    const named = rest.match(/\b(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)[A-Z]*\s*\/?\s*(\d{4}|\d{2})\b/)
    const numeric = rest.match(/(?<![\d/])(0[1-9]|1[0-3])\/(20\d{2})(?![\d/])/)
    if (named) {
      const y = named[2].length === 2 ? `20${named[2]}` : named[2]
      competencia = `${y}-${String(MESES.indexOf(named[1]) + 1).padStart(2, '0')}`
      rest = rest.replace(named[0], ' ')
    } else if (numeric) {
      competencia = `${numeric[2]}-${numeric[1]}`
      rest = rest.replace(numeric[0], ' ')
    }
    if (/13\s*(O|º)?\s*SAL/.test(l) && competencia) competencia = `${competencia.slice(0, 4)}-13`
    const amounts = rest.match(AMOUNT)
    if (!amounts) continue
    const valor = brNumber(amounts[0])
    if (!(valor > 0)) continue
    const inferida = !competencia
    if (!competencia) {
      if (!date) continue
      competencia = prevMonth(`${date[3]}-${date[2]}`)
    }
    out.push({ competencia, valor, linha: raw.trim(), inferida })
  }
  return out
}

/** The Caixa "Extrato completo" (app FGTS): monthly JAM credits and/or the rescisão value header. */
export function looksLikeFgtsExtract(lines: string[]): boolean {
  const t = fold(lines.slice(0, 60).join('\n'))
  return /CREDITO DE JAM|VALOR PARA FINS RESCISORIOS/.test(t) && /\bDEP/.test(t)
}

/** Soma os depósitos por competência (uma competência pode ter mais de um depósito, ex.: complemento). */
export function depositsByMonth(list: FgtsDeposit[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const d of list) out[d.competencia] = round((out[d.competencia] ?? 0) + d.valor)
  return out
}

/** Competência para leitura: "2025-10" → "10/2025", "2025-13" → "13º/2025". */
export const compLabel = (c: string) => (c.endsWith('-13') ? `13º/${c.slice(0, 4)}` : `${c.slice(5, 7)}/${c.slice(0, 4)}`)
