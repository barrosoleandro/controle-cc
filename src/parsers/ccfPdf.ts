import type { AccountHint, Checkpoint, ParseResult, ParsedTransaction } from '../domain/types'
import type { Row } from './pdfText'
import { round2 } from './util'

// Columns: date x≈54, value date x≈86, operation x≈135, debit amounts x≈420–470,
// credit amounts from x≈500. Rows without a leading date are details (mandate
// references, exchange rates…) and are left out.
const CREDIT_X = 478
const AMOUNT_X = 380

const DATE = /^(\d{2})\/(\d{2})$/
const VALUE_DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/
const AMOUNT = /^\d{1,3}(?:[\s  ]\d{3})*,\d{2}$/

const MONTHS: Record<string, string> = {
  janvier: '01', fevrier: '02', mars: '03', avril: '04', mai: '05', juin: '06',
  juillet: '07', aout: '08', septembre: '09', octobre: '10', novembre: '11', decembre: '12',
}
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const eur = (s: string) => round2(Number(s.replace(/[\s  €¤]/g, '').replace(',', '.')))

export function looksLikeCcfPdf(lines: string[]): boolean {
  return lines.some((l) => /CCF, société anonyme|CCF PARIS|CCDFFRPP/.test(l))
}

/** CCF statement ("Relevé COMPTE CHEQUES 1/2", "Relevé LIVRET A"); other CCF letters are ignored. */
export function parseCcfPdf(pages: Row[][], lines: string[]): ParseResult {
  const title = lines.map((l) => /^Relevé (COMPTE CHEQUES? \d?|LIVRET A)\b/.exec(l.trim())).find(Boolean)
  if (!title || !lines.some((l) => /Arrêté au/.test(l)))
    return { source: 'ignored', transactions: [], checkpoints: [], warnings: ['Documento do CCF sem lançamentos (carta, aviso ou relevé de frais) — ignorado.'] }

  // "Compte 41926377 40" on page 1, or "NUMÉRO DE COMPTE 18079 75293 04192637741 31".
  const plain = lines.map((l) => /Compte (\d{8}) (\d{2})\b/.exec(l)).find(Boolean)
  const rib = lines.map((l) => /NUMÉRO DE COMPTE\s+\d{5}\s+\d{5}\s+0(\d{8})(\d{2})\b/.exec(l)).find(Boolean)
  const num = plain ?? rib
  if (!num) throw new Error('Relevé CCF: número da conta não encontrado.')
  const accountRef = `CCF-${num[1]}-${num[2]}`
  const livret = /LIVRET/.test(title[1])
  const accounts: AccountHint[] = [{
    ref: accountRef, name: `CCF ${livret ? 'Livret A' : `Compte chèques ${title[1].replace(/\D/g, '') || ''}`.trim()}`,
    bank: 'CCF', currency: 'EUR', type: livret ? 'savings' : 'checking',
  }]

  const transactions: ParsedTransaction[] = []
  const checkpoints: Checkpoint[] = []
  const warnings: string[] = []
  let totals: [number, number] | null = null

  for (const rows of pages) {
    for (const row of rows) {
      // x < 45 is the vertical margin note ("Émis le … Réf : …"), which can share a row's height.
      const cells = row.cells.filter((c) => c.x0 >= 45).map((c) => ({ ...c, str: c.str.trim() })).filter((c) => c.str)
        // Some statements print the value date and the operation in one text run.
        .flatMap((c) => {
          const glued = /^(\d{2}\/\d{2}\/\d{4})\s+(.+)$/.exec(c.str)
          return glued ? [{ ...c, str: glued[1] }, { ...c, x0: c.x0 + 50, str: glued[2] }] : [c]
        })
      const text = cells.map((c) => c.str).join(' ').replace(/\s+/g, ' ')

      const solde = /^(ANCIEN|NOUVEAU) SOLDE(?: CR[ÉE]DITEUR| D[ÉE]BITEUR)? AU (\d{1,2}) (\S+) (\d{4}) ([\d\s  ]+,\d{2}) ?[€¤]/.exec(text)
      if (solde) {
        const month = MONTHS[fold(solde[3])]
        const sign = /D[ÉE]BITEUR/.test(text) ? -1 : 1
        if (month) checkpoints.push({ accountRef, date: `${solde[4]}-${month}-${solde[2].padStart(2, '0')}`, balance: sign * eur(solde[5]) })
        continue
      }
      const total = /^TOTAL DES OPÉRATIONS DU RELEVÉ ([\d\s  ]+,\d{2}) ([\d\s  ]+,\d{2})$/.exec(text)
      if (total) { totals = [eur(total[1]), eur(total[2])]; continue }

      const d = cells[0] && DATE.exec(cells[0].str)
      const v = cells[1] && VALUE_DATE.exec(cells[1].str)
      const amount = [...cells].reverse().find((c) => AMOUNT.test(c.str) && c.x0 >= AMOUNT_X)
      if (!d || !v || !amount) continue

      // The booking day has no year: take the one that puts it closest to the value date.
      const valueDate = `${v[3]}-${v[2]}-${v[1]}`
      const candidates = [-1, 0, 1].map((k) => `${Number(v[3]) + k}-${d[2]}-${d[1]}`)
      const bookingDate = candidates.reduce((a, b) => (Math.abs(Date.parse(b) - Date.parse(valueDate)) < Math.abs(Date.parse(a) - Date.parse(valueDate)) ? b : a))
      const description = cells.slice(2).filter((c) => c !== amount).map((c) => c.str).join(' ').replace(/\s+/g, ' ')
      const value = eur(amount.str)
      transactions.push({ accountRef, bookingDate, valueDate, description, amount: amount.x0 >= CREDIT_X ? value : -value, currency: 'EUR' })
    }
  }

  const debits = round2(-transactions.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0))
  const credits = round2(transactions.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0))
  if (totals && (Math.abs(totals[0] - debits) > 0.05 || Math.abs(totals[1] - credits) > 0.05))
    warnings.push(`Débitos/créditos lidos (${debits.toFixed(2)} / ${credits.toFixed(2)}) diferem do total do relevé (${totals[0].toFixed(2)} / ${totals[1].toFixed(2)}).`)
  return { source: 'ccf_pdf', transactions, checkpoints, warnings, accounts }
}
