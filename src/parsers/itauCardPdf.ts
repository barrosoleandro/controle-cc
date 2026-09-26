import type { AccountHint, CardStatement, ParseResult, ParsedTransaction } from '../domain/types'
import { CARD_PAYMENT } from '../domain/categorize'
import { addMonths } from './itauCardXlsx'
import type { Cell, Row } from './pdfText'
import { round2 } from './util'

// The transaction pages are laid out in two columns (left from x≈155, right from x≈371).
// Each column is read top to bottom, left before right, page after page.
const SPLIT_X = 360

const DATE = /^(\d{2})\/(\d{2})$/
const MONEY = /^(-\s?)?[\d.]+,\d{2}$/
const PARCEL = /\s*(\d{2})\/(\d{2})$/

/** '1.234,56' → 1234.56; '- 0,01' → -0.01 */
function brl(s: string): number {
  const neg = s.trim().startsWith('-')
  const n = Number(s.replace(/[-\s.]/g, '').replace(',', '.'))
  return round2(neg ? -n : n)
}

const text = (cells: Cell[]) => cells.map((c) => c.str.trim()).filter(Boolean).join(' ')

type Section = 'none' | 'charges' | 'payments' | 'international' | 'future'

export function looksLikeItauCardPdf(lines: string[]): boolean {
  return lines.some((l) => /Resumo da fatura em R\$/.test(l))
}

/**
 * Itaú credit-card bill (fatura) as PDF. One account per bill, named after the holder's
 * card ("Cartão 4771.XXXX.XXXX.1377"); additional cards' purchases go to the same account
 * with the card end in the subcategory. Purchases are money out; "Pagamentos efetuados"
 * become CARD_PAYMENT credits so they pair with the checking-account debit. Instalments
 * follow the Excel reader: parcela k of a purchase on day D is dated D + (k-1) months.
 * Future instalments ("Compras parceladas - próximas faturas") are not imported.
 */
export function parseItauCardPdf(pages: Row[][], lines: string[], today = new Date().toISOString().slice(0, 10)): ParseResult {
  const warnings: string[] = []
  const find = (re: RegExp) => lines.map((l) => re.exec(l)).find(Boolean) ?? null

  const card = find(/Cart[aã]o\s+\d{4}\.X{4}\.X{4}\.(\d{4})/)?.[1]
  const due = find(/Vencimento:\s*(\d{2})\/(\d{2})\/(\d{4})/)
  const issued = find(/Emiss[aã]o:\s*(\d{2})\/(\d{2})\/(\d{4})/)
  if (!card) throw new Error('Fatura Itaú (PDF): número do cartão não encontrado.')
  if (!due || !issued) throw new Error('Fatura Itaú (PDF): datas de vencimento/emissão não encontradas.')
  const dueDate = `${due[3]}-${due[2]}-${due[1]}`
  const issuedDate = `${issued[3]}-${issued[2]}-${issued[1]}`
  const total = find(/Total desta fatura\s+(-?\s?[\d.]+,\d{2})/)
  const current = find(/Lançamentos atuais\s+(-?\s?[\d.]+,\d{2})/)

  // Purchases show day/month only: the year is the bill's, or the previous one for later months.
  const [iy, im] = [Number(issued[3]), Number(issued[2])]
  const isoOf = (d: string, m: string) => `${Number(m) > im ? iy - 1 : iy}-${m}-${d}`

  const accountRef = `ITAUCARD-${card}`
  const accounts: AccountHint[] = [{ ref: accountRef, name: `Itaú cartão final ${card}`, bank: 'ITAU', currency: 'BRL', type: 'card' }]

  const transactions: ParsedTransaction[] = []
  let section: Section = 'none'
  let holder = card
  let last: ParsedTransaction | null = null
  let done = false

  const columns = pages.flatMap((rows) => [
    rows.map((r) => r.cells.filter((c) => c.x0 < SPLIT_X)),
    rows.map((r) => r.cells.filter((c) => c.x0 >= SPLIT_X)),
  ])

  for (const column of columns) {
    last = null // a category line never continues into another column
    for (const cells of column) {
      if (done || !cells.length) continue
      const line = text(cells)
      if (/Total dos lançamentos atuais/i.test(line)) { done = true; continue }
      if (/^Lançamentos: /i.test(line)) { section = 'charges'; last = null; continue }
      if (/^Pagamentos efetuados/i.test(line)) { section = 'payments'; last = null; continue }
      if (/^Lançamentos internacionais/i.test(line)) { section = 'international'; last = null; continue }
      if (/^Compras parceladas/i.test(line)) { section = 'future'; last = null; continue }
      if (section === 'none' || section === 'future') continue

      const owner = /\(final (\d{4})\)$/.exec(line)
      if (owner && !/^Lançamentos no cartão/i.test(line)) { holder = owner[1]; last = null; continue }

      const iof = /^Repasse de IOF em R\$\s+([\d.]+,\d{2})$/.exec(line)
      if (iof) {
        transactions.push({ accountRef, bookingDate: issuedDate, description: 'REPASSE DE IOF (INTERNACIONAL)', amount: -brl(iof[1]), currency: 'BRL', statementDue: dueDate })
        last = null
        continue
      }

      const date = DATE.exec(cells[0].str.trim())
      const value = cells.length >= 3 && MONEY.test(cells.at(-1)!.str.trim()) ? brl(cells.at(-1)!.str) : null
      if (date && value !== null) {
        let estab = text(cells.slice(1, -1))
        const p = PARCEL.exec(estab)
        if (p) estab = estab.slice(0, p.index).trim()
        const purchase = isoOf(date[1], date[2])
        const k = p ? Number(p[1]) : 1
        const payment = section === 'payments'
        last = {
          accountRef,
          bookingDate: p ? addMonths(purchase, k - 1) : purchase,
          valueDate: purchase,
          description: p ? `${estab} (${k}/${Number(p[2])})` : estab,
          amount: round2(-value), // the bill shows purchases as positive, payments as negative
          currency: 'BRL',
          bankCategory: payment ? CARD_PAYMENT : undefined,
          bankSubcategory: payment ? undefined : `cartão final ${holder}`,
          statementDue: dueDate,
        }
        transactions.push(last)
        continue
      }

      // The line under a purchase: "VESTUÁRIO .BELO HORIZONT", or for foreign ones "CROISSY SUR S 19,14 EUR 22,34".
      if (last && !last.bankCategory && !/^(DATA|Lançamentos no cartão|Total|Dólar)/i.test(line)) {
        const cat = /^(.+?)\s*\.(.*)$/.exec(line)
        if (section === 'international' || !cat) last.bankSubcategory = `${line} · ${last.bankSubcategory}`
        else {
          last.bankCategory = cat[1].trim()
          if (cat[2].trim()) last.bankSubcategory = `${cat[2].trim()} · ${last.bankSubcategory}`
        }
        last = null
      }
    }
  }

  if (!done) warnings.push('Fim dos lançamentos ("Total dos lançamentos atuais") não encontrado: confira a fatura.')
  const charges = round2(transactions.filter((t) => t.bankCategory !== CARD_PAYMENT).reduce((s, t) => s - t.amount, 0))
  if (current && Math.abs(charges - brl(current[1])) > 0.05)
    warnings.push(`Soma dos lançamentos (${charges.toFixed(2)}) difere dos lançamentos atuais da fatura (${brl(current[1]).toFixed(2)}).`)

  // Without a "Pagamentos efetuados" section, the payment only shows in the summary.
  if (!transactions.some((t) => t.bankCategory === CARD_PAYMENT)) {
    const paid = find(/Pagamento efetuado em (\d{2})\/(\d{2})\/(\d{4})\s+(-\s?[\d.]+,\d{2})/)
    if (paid) transactions.push({
      accountRef, bookingDate: `${paid[3]}-${paid[2]}-${paid[1]}`, description: 'PAGAMENTO EFETUADO',
      amount: -brl(paid[4]), currency: 'BRL', bankCategory: CARD_PAYMENT, statementDue: dueDate,
    })
  }

  const cardStatements: CardStatement[] = [{
    accountRef, dueDate, status: dueDate < today ? 'paga' : 'aberta', total: total ? brl(total[1]) : charges,
  }]
  return { source: 'itau_card_pdf', transactions, checkpoints: [], warnings, accounts, cardStatements }
}
