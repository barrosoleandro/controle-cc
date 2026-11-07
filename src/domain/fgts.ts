/**
 * FGTS de expatriado (CLT ativa, transferido, Lei 7.064/82, art. 3º, parágrafo único): os 8% incidem
 * sobre a remuneração total, inclusive a paga no exterior. O esperado de cada competência vem do
 * bruto do holerite francês convertido em reais; o depositado vem do extrato do FGTS (app FGTS).
 */
export const FGTS_RATE = 0.08

export interface FgtsPayslip { period: string; gross: number | null; pay_date: string | null }
export interface FgtsRow {
  competencia: string // yyyy-mm
  brutoEur: number
  taxa: number // EUR→BRL usada
  dataTaxa: string
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
  /** Depósitos de competências sem holerite francês (ex.: antes da transferência, ou 13º). */
  outros: { competencia: string; valor: number }[]
}

const round = (v: number) => Math.round(v * 100) / 100
const lastDay = (ym: string) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}` }

/** `eurBrl(date)`: the rate of that day. The pay date is used; without one, the last day of the month. */
export function checkFgts(payslips: FgtsPayslip[], deposits: Record<string, number>, eurBrl: (date: string) => number): FgtsCheck {
  const rows = payslips.filter((p) => p.gross && p.gross > 0).map((p) => {
    const competencia = p.period.slice(0, 7)
    const dataTaxa = p.pay_date ?? lastDay(competencia)
    const taxa = eurBrl(dataTaxa)
    const baseBrl = round(p.gross! * taxa)
    const esperado = round(baseBrl * FGTS_RATE)
    const dep = deposits[competencia]
    const depositado = dep === undefined ? null : dep
    return { competencia, brutoEur: p.gross!, taxa, dataTaxa, baseBrl, esperado, depositado,
      diferenca: depositado === null ? null : round(depositado - esperado), baseImplicita: depositado === null ? null : round(depositado / FGTS_RATE) }
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
    if (!/\bDEP/.test(l) || /JAM|SAQUE|ESTORNO|SALDO ANTERIOR|TOTAL/.test(l)) continue
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

/** Soma os depósitos por competência (uma competência pode ter mais de um depósito, ex.: complemento). */
export function depositsByMonth(list: FgtsDeposit[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const d of list) out[d.competencia] = round((out[d.competencia] ?? 0) + d.valor)
  return out
}

/** Competência para leitura: "2025-10" → "10/2025", "2025-13" → "13º/2025". */
export const compLabel = (c: string) => (c.endsWith('-13') ? `13º/${c.slice(0, 4)}` : `${c.slice(5, 7)}/${c.slice(0, 4)}`)
