import type { Checkpoint, ParseResult, ParsedTransaction } from '../domain/types'
import { frDateToIso, parseEuroNumber } from './util'

const LINE = /^(\d{2}\/\d{2}\/\d{4})\s+(.+?)\s{2,}(-?[\d.]+,\d{2})$/

/** Itaú "extrato conta / lançamentos" PDF export (reverse chronological). */
export function parseItauPdf(lines: string[]): ParseResult {
  const header = lines.find((l) => /agência:\s*\d+\s+conta:\s*[\d-]+/.test(l)) ?? ''
  const acc = /agência:\s*(\d+)\s+conta:\s*([\d-]+)/.exec(header)
  const accountRef = acc ? `${acc[1]}/${acc[2]}` : ''
  const warnings: string[] = []
  if (!accountRef) warnings.push('Itaú account number not found.')
  const transactions: ParsedTransaction[] = []
  const checkpoints: Checkpoint[] = []
  for (const raw of lines) {
    const m = LINE.exec(raw.trim())
    if (!m) continue
    const date = frDateToIso(m[1])
    const desc = m[2].replace(/\s{2,}/g, ' ').trim()
    const value = parseEuroNumber(m[3])
    if (/^SALDO (DO DIA|ANTERIOR)/.test(desc)) {
      checkpoints.push({ accountRef, date, balance: value })
    } else {
      transactions.push({ accountRef, bookingDate: date, description: desc, amount: value, currency: 'BRL' })
    }
  }
  // File is newest-first; store oldest-first so occurrence indexes are stable.
  transactions.reverse()
  return { source: 'itau_pdf', transactions, checkpoints, warnings }
}

export function looksLikeItauPdf(lines: string[]): boolean {
  return lines.some((l) => /extrato conta \/ lançamentos/.test(l))
}
