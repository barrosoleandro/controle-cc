import type { Checkpoint, ParseResult, ParsedTransaction } from '../domain/types'
import type { Cell, Row } from './pdfText'
import { round2 } from './util'

// "Extrato conta corrente" table: date at x≈40, kind ("PIX RECEBIDO") at x≈100, description
// at x≈256 (wrapping onto the next rows), amount around x≈420–450, daily balance from x≈490.
const KIND_X = 90
const DESC_X = 240
const AMOUNT_X = 400
const BALANCE_X = 490

const DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/
const MONEY = /^-?[\d.]+,\d{2}$/

function brl(s: string): number {
  const t = s.trim()
  const n = Number(t.replace(/[-.]/g, '').replace(',', '.'))
  return round2(t.startsWith('-') ? -n : n)
}

/**
 * The kind of movement, worded like the bank's older app export ("PAG BOLETO PLANO…",
 * "PIX TRANSF Wise…"), so the learned rules keep matching. Kinds the description already
 * says ("PERS INFINIT" is the card bill, "REND PAGO APLIC AUT MAIS" the yield) get no prefix.
 */
const PREFIX: [RegExp, string][] = [
  [/^PAGAMENTO DE BOLETO$/i, 'PAG BOLETO'],
  [/^PIX (RECEBIDO|ENVIADO|TRANSF)/i, 'PIX TRANSF'],
  [/^PAGAMENTO DE PIX QR ?CODE$/i, 'PIX QRS'],
  [/^(D[ÉE]BITO AUTOM[ÁA]TICO|RENDIMENTOS|PAGAMENTO DE SEGURO)$/i, ''],
]

export function looksLikeItauAccountPdf(lines: string[]): boolean {
  return lines.some((l) => /^Extrato conta corrente$/.test(l.trim())) && lines.some((l) => /agência:\s*\d+\s+conta:\s*[\d-]+/.test(l))
}

/**
 * Itaú "Extrato conta corrente" PDF (app/site export, newest first). Each day opens with its
 * end-of-day balance; the rows under it were posted that day, even when they show an earlier
 * date (a bill paid on Saturday shows Saturday but is posted on Monday). They are booked on
 * the balance's day, the date the older export and the monthly statement use, so the same
 * operation is recognised when the periods overlap.
 */
export function parseItauAccountPdf(pages: Row[][], lines: string[]): ParseResult {
  const acc = lines.map((l) => /agência:\s*(\d+)\s+conta:\s*0*(\d+)-(\d)/.exec(l)).find(Boolean)
  if (!acc) throw new Error('Extrato Itaú: agência/conta não encontradas.')
  const accountRef = `${acc[1]}/${acc[2].padStart(6, '0')}-${acc[3]}`

  const iso = (m: RegExpExecArray) => `${m[3]}-${m[2]}-${m[1]}`
  const transactions: ParsedTransaction[] = []
  const checkpoints: Checkpoint[] = []
  const warnings: string[] = []
  let inTable = false
  let done = false
  let posted = '' // day of the last balance row
  let last: { tx: ParsedTransaction; kind: string; desc: string } | null = null

  const finish = () => {
    if (!last) return
    const kind = last.kind.replace(/\s+/g, ' ').trim()
    const prefix = PREFIX.find(([re]) => re.test(kind))
    const head = prefix ? prefix[1] : kind
    last.tx.description = [head, last.desc.replace(/\s+/g, ' ').trim()].filter(Boolean).join(' ')
    transactions.push(last.tx)
    last = null
  }
  const words = (cells: Cell[], from: number, to: number) => cells.filter((c) => c.x0 >= from && c.x0 < to).map((c) => c.str.trim()).join(' ')

  for (const rows of pages) {
    for (const row of rows) {
      if (done) break
      const line = row.cells.map((c) => c.str.trim()).join(' ')
      if (/^Data Lançamentos Descrição/.test(line)) { inTable = true; continue }
      if (!inTable) continue
      if (/^Posição consolidada/i.test(line)) { done = true; break }

      const date = DATE.exec(row.cells[0]?.str.trim() ?? '')
      const amount = row.cells.find((c) => c.x0 >= AMOUNT_X && c.x0 < BALANCE_X && MONEY.test(c.str.trim()))
      const balance = row.cells.find((c) => c.x0 >= BALANCE_X && MONEY.test(c.str.trim()))
      if (date && balance && !amount) {
        finish()
        posted = iso(date)
        checkpoints.push({ accountRef, date: posted, balance: brl(balance.str) })
        continue
      }
      if (date && amount) {
        finish()
        const day = iso(date)
        last = {
          tx: { accountRef, bookingDate: posted || day, valueDate: day, description: '', amount: brl(amount.str), currency: 'BRL' },
          kind: words(row.cells, KIND_X, DESC_X),
          desc: words(row.cells, DESC_X, AMOUNT_X),
        }
        continue
      }
      // A wrapped line of the kind ("PAGAMENTO DE PIX QR" / "CODE") or of the description.
      if (last && !date) {
        last.kind += ` ${words(row.cells, KIND_X, DESC_X)}`
        last.desc += ` ${words(row.cells, DESC_X, AMOUNT_X)}`
      }
    }
  }
  finish()
  if (!done) warnings.push('Fim dos lançamentos ("Posição consolidada") não encontrado: confira o extrato.')

  // Each balance must follow from the previous (older) one plus the rows posted that day.
  // A negative balance (the overdraft in use) is printed without its sign: "518,51" for
  // -518,51. Walking from the oldest balance up, the sign is put back where only it differs.
  const byDay = new Map<string, number>()
  for (const t of transactions) byDay.set(t.bookingDate, round2((byDay.get(t.bookingDate) ?? 0) + t.amount))
  for (let i = checkpoints.length - 2; i >= 0; i--) {
    const [now, before] = [checkpoints[i], checkpoints[i + 1]]
    if (now.date === before.date) continue
    const expected = round2(before.balance + (byDay.get(now.date) ?? 0))
    if (expected < 0 && Math.abs(-expected - now.balance) <= 0.05) now.balance = -now.balance
    else if (Math.abs(expected - now.balance) > 0.05) warnings.push(`Saldo de ${now.date} (${now.balance.toFixed(2)}) não fecha com os lançamentos (${expected.toFixed(2)}).`)
  }

  // File is newest-first; store oldest-first so occurrence indexes are stable.
  transactions.reverse()
  return { source: 'itau_pdf', transactions, checkpoints, warnings }
}
