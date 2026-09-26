import type { Checkpoint, ParseResult, ParsedTransaction } from '../domain/types'
import { frDateToIso, parseEuroNumber } from './util'

const SECTION = /^(?:COMPTE DE DEPOT JOINT|LIV\.A EN CPTE|LIV DEVT DURABLE ET SOLIDAIRE|[A-Z .]+?)\s+-\s+N°\s+(\d{11})\s*$/
const OP = /^(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+(.+?)\s{2,}([+-])\s?([\d  ]+,\d{2})$/
const SOLDE = /^SOLDE (?:CREDITEUR|DEBITEUR)(?: AU (\d{2}\/\d{2}\/\d{4}))?\s+([+-])\s?([\d  ]+,\d{2})$/
const SYNTH = /N°\s+\d{5}\s+\d{5}\s+(\d{11})\s+Solde au (\d{2}\/\d{2}\/\d{4})\s+([+-])\s?([\d  ]+,\d{2})$/

/** Banque BCP monthly statement ("RELEVES_*.pdf"), possibly with several accounts. */
export function parseBcpPdf(lines: string[]): ParseResult {
  const transactions: ParsedTransaction[] = []
  const checkpoints: Checkpoint[] = []
  const warnings: string[] = []
  let account = ''
  for (const raw of lines) {
    const line = raw.trim()
    const synth = SYNTH.exec(line)
    if (synth) {
      checkpoints.push({ accountRef: synth[1], date: frDateToIso(synth[2]), balance: parseEuroNumber(synth[3] + synth[4]) })
      continue
    }
    const sec = SECTION.exec(line)
    if (sec) { account = sec[1]; continue }
    const cont = /N°\s+\d{5}\s+\d{5}\s+(\d{11})\s+\(suite\)/.exec(line)
    if (cont) { account = cont[1]; continue }
    if (!account) continue
    const s = SOLDE.exec(line)
    if (s) {
      if (s[1]) checkpoints.push({ accountRef: account, date: frDateToIso(s[1]), balance: parseEuroNumber(s[2] + s[3]) })
      continue
    }
    const m = OP.exec(line)
    if (m) {
      transactions.push({
        accountRef: account,
        bookingDate: frDateToIso(m[1]),
        valueDate: frDateToIso(m[2]),
        description: m[3].replace(/\s{2,}/g, ' ').trim(),
        amount: parseEuroNumber(m[4] + m[5]),
        currency: 'EUR',
      })
    }
  }
  if (transactions.length === 0 && checkpoints.length === 0) warnings.push('No operations found — is this a Banque BCP statement?')
  return { source: 'bcp_pdf', transactions, checkpoints: dedupeCheckpoints(checkpoints), warnings }
}

function dedupeCheckpoints(cps: Checkpoint[]): Checkpoint[] {
  const map = new Map<string, Checkpoint>()
  for (const c of cps) map.set(`${c.accountRef}|${c.date}`, c)
  return [...map.values()]
}

export function looksLikeBcpPdf(lines: string[]): boolean {
  return lines.some((l) => /Banque BCP|BANQUE BCP/.test(l)) && lines.some((l) => /relevé de comptes/i.test(l))
}
