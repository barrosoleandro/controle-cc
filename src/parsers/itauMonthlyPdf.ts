import type { Checkpoint, ParseResult, ParsedTransaction } from '../domain/types'
import type { Cell, Row } from './pdfText'
import { round2 } from './util'

// "Conta Corrente | Movimentação" table: date at x≈150, description at x≈207, credits
// around x≈360–400, debits end with "-" (x≈420–450), balance from x≈500 (ignored).
const LEGEND_X = 140 // the left-hand legend ("A = agendamento"…) sits before this
const BALANCE_X = 490

const DATE = /^(\d{2})\/(\d{2})$/
const AMOUNT = /^[\d.]+,\d{2}-?$/

/**
 * The account is read as checking + "Aplic Aut Mais" together, like the bank's own
 * totals: the sweeps between them ("Res/Apl Aplic Aut Mais") are internal and left out,
 * the yield ("Rend Pago Aplic Aut Mais") is income.
 */
const SKIP = /^(Saldo (anterior|final|em C\/C|Aplic Aut)|Res Aplic Aut|Apl Aplic Aut)/i

function brl(s: string): number {
  const neg = s.endsWith('-')
  const n = Number(s.replace(/[-.]/g, '').replace(',', '.'))
  return round2(neg ? -n : n)
}

export function looksLikeItauMonthlyPdf(lines: string[]): boolean {
  return lines.some((l) => /extrato\s*mensal\s+ag\s+\d+\s+cc\s+\d+-\d/.test(l))
}

/** Itaú Personnalité "Extrato Mensal" PDF (checking account and automatic investment). */
export function parseItauMonthlyPdf(pages: Row[][], lines: string[]): ParseResult {
  const warnings: string[] = []
  const acc = lines.map((l) => /ag\s+(\d+)\s+cc\s+(\d+)-(\d)/.exec(l)).find(Boolean)
  if (!acc) throw new Error('Extrato mensal Itaú: agência/conta não encontradas.')
  const accountRef = `${acc[1]}/${acc[2].padStart(6, '0')}-${acc[3]}`

  const period = lines.map((l) => /saldo em (\d{2})\/(\d{2})\/(\d{2}).*saldo em (\d{2})\/(\d{2})\/(\d{2})/.exec(l)).find(Boolean)
  if (!period) throw new Error('Extrato mensal Itaú: período não encontrado.')
  const endYear = 2000 + Number(period[6])
  const endMonth = Number(period[5])
  const iso = (d: string, m: string) => `${Number(m) > endMonth ? endYear - 1 : endYear}-${m}-${d}`
  const startDate = `20${period[3]}-${period[2]}-${period[1]}`
  const endDate = `20${period[6]}-${period[5]}-${period[4]}`

  const transactions: ParsedTransaction[] = []
  const checkpoints: Checkpoint[] = []
  let inTable = false
  let done = false
  let date = ''

  for (const rows of pages) {
    for (const row of rows) {
      if (done) break
      const cells = row.cells.filter((c) => c.x0 >= LEGEND_X)
      const text = cells.map((c) => c.str.trim()).join(' ')
      if (/Movimentação/.test(row.cells.map((c) => c.str).join(' '))) { inTable = true; continue }
      if (!inTable || !cells.length) continue
      if (/^totalizador de aplicações/i.test(text)) { done = true; break }

      if (DATE.test(cells[0].str.trim())) {
        const m = DATE.exec(cells[0].str.trim())!
        date = iso(m[1], m[2])
      }
      const words = cells.filter((c) => !DATE.test(c.str.trim()) && !AMOUNT.test(c.str.trim()))
      const desc = words.map((c) => c.str.trim()).join(' ').replace(/\s+/g, ' ')
      const amounts = cells.filter((c) => AMOUNT.test(c.str.trim()))
      const balance = amounts.find((c) => c.x0 >= BALANCE_X)
      const moves = amounts.filter((c) => c.x0 < BALANCE_X || c.str.trim().endsWith('-'))

      if (/^Saldo anterior/i.test(desc) && balance) checkpoints.push({ accountRef, date: startDate, balance: brl(balance.str.trim()) })
      if (/^Saldo final/i.test(desc) && balance) { checkpoints.push({ accountRef, date: endDate, balance: brl(balance.str.trim()) }); continue }
      if (!desc || SKIP.test(desc) || !date || /^(data|descrição|\(créditos\))/i.test(desc)) continue
      for (const a of moves as Cell[]) {
        transactions.push({ accountRef, bookingDate: date, description: desc, amount: brl(a.str.trim()), currency: 'BRL' })
      }
    }
  }

  // The bank's own totals of the month: every credit and debit, sweeps excluded.
  const totals = lines.map((l) => /^total\s+([\d.]+,\d{2})$/.exec(l.trim())).filter(Boolean).map((m) => brl(m![1]))
  const credits = round2(transactions.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0))
  const debits = round2(-transactions.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0))
  if (totals.length >= 2 && (Math.abs(totals[0] - credits) > 0.05 || Math.abs(totals[1] - debits) > 0.05))
    warnings.push(`Entradas/saídas lidas (${credits.toFixed(2)} / ${debits.toFixed(2)}) diferem do resumo do extrato (${totals[0].toFixed(2)} / ${totals[1].toFixed(2)}).`)
  if (!done) warnings.push('Fim da movimentação não encontrado: confira o extrato.')
  return { source: 'itau_monthly_pdf', transactions, checkpoints, warnings }
}
