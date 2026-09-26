import type { Checkpoint, ParseResult, ParsedTransaction } from '../domain/types'
import { round2 } from './util'

// "7.03   7.03   COMPRA 8695 LISBON DUTY FREE   59.50   1 657.26" — M.DD dates, amounts with
// a space as thousands separator. Debit and credit share the line; the sign comes from
// the running balance, which is more reliable than guessing the column from its x position.
const AMOUNT = String.raw`-?\d{1,3}(?: \d{3})*\.\d{2}-?`
const LINE = new RegExp(String.raw`^(\d{1,2})\.(\d{2})\s+(\d{1,2})\.(\d{2})\s+(.+?)\s{2,}(${AMOUNT})\s{2,}(${AMOUNT})$`)
const OPENING = new RegExp(String.raw`^SALDO INICIAL\s+(${AMOUNT})$`)

/** '1 717.08' → 1717.08; '12.50-' → -12.5 */
function ptNumber(s: string): number {
  const neg = s.startsWith('-') || s.endsWith('-')
  const n = Number(s.replace(/[\s-]/g, ''))
  if (!Number.isFinite(n)) throw new Error(`Invalid amount: ${s}`)
  return round2(neg ? -n : n)
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Millennium bcp (Portugal) "Extrato Combinado" PDF — conta à ordem section. */
export function parseMillenniumPdf(lines: string[]): ParseResult {
  const warnings: string[] = []
  const trimmed = lines.map((l) => l.trim())
  const accountRef = trimmed.map((l) => /CONTA MILLENNIUM\s+N\.\s*(\d+)/.exec(l)?.[1] ?? /CONTA:\s+(\d{8,})/.exec(l)?.[1]).find(Boolean) ?? ''
  const period = trimmed.map((l) => /EXTRATO DE (\d{4})\/(\d{2})\/(\d{2}) A (\d{4})\/(\d{2})\/(\d{2})/.exec(l)).find(Boolean)
  if (!accountRef) throw new Error('Millennium: número da conta não encontrado.')
  if (!period) throw new Error('Millennium: período do extrato não encontrado.')
  const startYear = Number(period[1]), startMonth = Number(period[2])
  // Statements can cross New Year: a month before the start month belongs to the next year.
  const iso = (m: number, d: number) => `${m < startMonth ? startYear + 1 : startYear}-${pad(m)}-${pad(d)}`

  const transactions: ParsedTransaction[] = []
  const checkpoints = new Map<string, Checkpoint>()
  let balance: number | null = null
  for (const l of trimmed) {
    const o = OPENING.exec(l)
    if (o) {
      balance = ptNumber(o[1])
      const d = new Date(Date.parse(`${period[1]}-${period[2]}-${period[3]}`) - 86400000).toISOString().slice(0, 10)
      checkpoints.set(d, { accountRef, date: d, balance })
      continue
    }
    const m = LINE.exec(l)
    if (!m) continue
    const amount = ptNumber(m[6])
    const after = ptNumber(m[7])
    if (balance === null) { warnings.push('Millennium: SALDO INICIAL não encontrado; sinais podem estar errados.'); balance = round2(after + Math.abs(amount)) }
    const delta = round2(after - balance)
    if (Math.abs(Math.abs(delta) - Math.abs(amount)) > 0.005)
      warnings.push(`Linha com saldo inconsistente: ${m[5]} (${m[6]})`)
    const bookingDate = iso(Number(m[1]), Number(m[2]))
    transactions.push({
      accountRef, bookingDate, valueDate: iso(Number(m[3]), Number(m[4])),
      description: m[5].replace(/\s{2,}/g, ' ').trim(),
      amount: delta < 0 ? -Math.abs(amount) : Math.abs(amount), currency: 'EUR',
    })
    balance = after
    checkpoints.set(bookingDate, { accountRef, date: bookingDate, balance: after })
  }
  return {
    source: 'millennium_pdf', transactions, checkpoints: [...checkpoints.values()], warnings,
    accounts: [{ ref: accountRef, name: `Millennium bcp ${accountRef}`, bank: 'MILLENNIUM', currency: 'EUR', type: 'checking' }],
  }
}

export function looksLikeMillenniumPdf(lines: string[]): boolean {
  return lines.some((l) => /EXTRATO COMBINADO/.test(l)) && lines.some((l) => /CONTA MILLENNIUM|millenniumbcp/i.test(l))
}

/** Single-operation receipts ("Nota de Lançamento"): the same line is already in the extrato. */
export function looksLikeMillenniumReceipt(lines: string[]): boolean {
  return lines.slice(0, 5).some((l) => /^Nota de Lançamento/.test(l.trim()))
}
