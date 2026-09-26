import Papa from 'papaparse'
import type { ParseResult, ParsedTransaction } from '../domain/types'
import { frDateToIso, parseEuroNumber } from './util'

/**
 * Banque BCP CSV export (';' separated, ISO-8859-1).
 * The account number is taken from the file name (e.g. 04033573329_01122025_26092026.csv).
 */
export function parseBcpCsv(text: string, fileName: string): ParseResult {
  const accountRef = /^(\d{11})_/.exec(fileName)?.[1] ?? ''
  const warnings: string[] = []
  if (!accountRef) warnings.push('Account number not found in file name; select the account manually.')
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, delimiter: ';', skipEmptyLines: true })
  const transactions: ParsedTransaction[] = []
  for (const r of parsed.data) {
    const date = r['Date de comptabilisation']
    if (!date) continue
    const raw = r['Debit'] || r['Credit']
    if (!raw) { warnings.push(`Row without amount on ${date}`); continue }
    transactions.push({
      accountRef,
      bookingDate: frDateToIso(date),
      valueDate: r['Date de valeur'] ? frDateToIso(r['Date de valeur']) : undefined,
      description: (r['Libelle operation'] || r['Libelle simplifie'] || '').trim(),
      amount: parseEuroNumber(raw),
      currency: 'EUR',
      bankCategory: r['Categorie'] || undefined,
      bankSubcategory: r['Sous categorie'] || undefined,
      externalId: r['Reference'] || undefined,
    })
  }
  return { source: 'bcp_csv', transactions, checkpoints: [], warnings }
}

export function looksLikeBcpCsv(text: string): boolean {
  return text.startsWith('Date de comptabilisation;')
}
