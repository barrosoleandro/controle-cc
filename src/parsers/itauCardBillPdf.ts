import type { AccountHint, CardStatement, ParseResult, ParsedTransaction } from '../domain/types'
import { CARD_PAYMENT } from '../domain/categorize'
import { unaccent } from '../domain/util'
import { addMonths } from './itauCardXlsx'
import type { Row } from './pdfText'
import { round2 } from './util'

// Rows: date at x≈36 ("15 / jul", "01 / agosto"), description at x≈160, value from x≈500
// ("R$ 450,65", "- R$ 1.234,56"). Section titles and card headers start at x≈28–45.
const VALUE_X = 480

const DATE = /^(\d{2})\s*\/\s*([a-zç]+)$/i
const VALUE = /^(-\s*)?R\$\s*([\d.]+,\d{2})$/
const PARCEL = /\s*\(?(\d{2})\/(\d{2})\)?$/
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']

function brl(s: string): number {
  const m = VALUE.exec(s.trim())!
  const n = Number(m[2].replace(/\./g, '').replace(',', '.'))
  return round2(m[1] ? -n : n)
}

type Section = 'none' | 'previous' | 'national' | 'international' | 'fees' | 'future'

export function looksLikeItauCardBillPdf(lines: string[]): boolean {
  return lines.some((l) => /venc\. da fatura/.test(l)) && lines.some((l) => /^fatura de$/.test(l.trim()))
}

/**
 * Itaú credit-card bill PDF in the layout of the app's "fatura aberta / próxima" screen
 * (Fatura_PERSONNALITE_VISA_INFINITE_1111_2026_12.pdf). It holds the same rows as the Excel
 * export and is read the same way: one account for the bill, purchases as money out, the
 * previous bill's payment as a CARD_PAYMENT credit, parcela k of a purchase on day D dated
 * D + (k-1) months. Each additional card's purchases keep the card end in the subcategory.
 * A "fatura próxima" only lists future instalments: it is read but not imported.
 */
export function parseItauCardBillPdf(pages: Row[][], lines: string[], fileName = ''): ParseResult {
  const warnings: string[] = []
  const flat = lines.map((l) => l.replace(/\s+/g, ' ').trim())

  // "fatura | valor até o momento | venc. da fatura …" then the values on the next line.
  const hdr = flat.findIndex((l) => /^fatura valor até o momento/.test(l))
  const values = hdr >= 0 ? flat[hdr + 1] ?? '' : ''
  const kind = /^(aberta|próxima|proxima|paga|fechada)\b/i.exec(values)?.[1].toLowerCase()
  const due = /(\d{2})\/(\d{2})\/(\d{4})/.exec(values)
  const shown = /R\$\s*([\d.]+,\d{2})/.exec(values)
  const issued = flat.map((l) => /emitido em (\d{2})\/(\d{2})\/(\d{4})/.exec(l)).find(Boolean)
  if (!kind || !due) throw new Error('Fatura Itaú (PDF): situação/vencimento da fatura não encontrados.')
  if (!issued) throw new Error('Fatura Itaú (PDF): data de emissão não encontrada.')
  const dueDate = `${due[3]}-${due[2]}-${due[1]}`

  // The bill lists every card on it; the account is the one in the file name ("…_1111_2026_12.pdf"),
  // else the first holder card.
  const cards = [...new Set(flat.map((l) => /- final (\d{4}) \((titular|adicional)\)$/.exec(l)).filter(Boolean).map((m) => `${m![1]}|${m![2]}`))]
  const card = /_(\d{4})_\d{4}_\d{2}\.pdf$/i.exec(fileName)?.[1]
    ?? cards.find((c) => c.endsWith('titular'))?.split('|')[0]
    ?? /- final (\d{4})$/.exec(flat.find((l) => /- final \d{4}$/.test(l)) ?? '')?.[1]
  if (!card) throw new Error('Fatura Itaú (PDF): número final do cartão não encontrado.')
  const accountRef = `ITAUCARD-${card}`

  // "000.000.000-00 1234 05555-0": CPF, agência and conta of the paying account.
  const acc = flat.map((l) => /\d{3}\.\d{3}\.\d{3}-\d{2} (\d{4}) 0*(\d+)-(\d)$/.exec(l)).find(Boolean)
  const parentRef = acc ? `${acc[1]}/${acc[2].padStart(6, '0')}-${acc[3]}` : undefined
  if (!parentRef) warnings.push('Agência/conta não encontradas: vincule o cartão à conta em Cartões.')
  const accounts: AccountHint[] = [{ ref: accountRef, name: `Itaú cartão final ${card}`, bank: 'ITAU', currency: 'BRL', type: 'card', parentRef }]

  // Purchases show day and month only: the year is the issue's, or the previous one for later months.
  const [iy, im] = [Number(issued[3]), Number(issued[2])]
  const isoOf = (day: string, month: string) => {
    const m = MONTHS.indexOf(unaccent(month).toLowerCase().slice(0, 3)) + 1
    if (!m) return null
    return `${m > im ? iy - 1 : iy}-${String(m).padStart(2, '0')}-${day}`
  }

  const transactions: ParsedTransaction[] = []
  let section: Section = 'none'
  let holder = card
  let intlDate: string | null = null // international rows: the date sits on the "dólar de conversão" row

  for (const rows of pages) {
    for (const row of rows) {
      const line = row.cells.map((c) => c.str.trim()).filter(Boolean).join(' ')
      if (!line) continue
      if (/^total da fatura anterior$/i.test(line)) { section = 'previous'; continue }
      if (/^lançamentos nacionais$/i.test(line)) { section = 'national'; continue }
      if (/^lançamentos internacionais$/i.test(line)) { section = 'international'; continue }
      if (/^encargos e serviços$/i.test(line)) { section = 'fees'; continue }
      if (/^compras parceladas$/i.test(line)) { section = 'future'; continue }
      const owner = /- final (\d{4})( \((titular|adicional)\))?$/.exec(line)
      if (owner && !/^total/i.test(line)) { holder = owner[1]; intlDate = null; continue }
      if (section === 'none' || section === 'future' || /^(total|data lançamento|IOF - Transação)/i.test(line)) continue

      const valueCell = row.cells.find((c) => c.x0 >= VALUE_X && VALUE.test(c.str.trim()))
      const date = DATE.exec(row.cells[0]?.str.trim() ?? '')
      const desc = row.cells.filter((c) => c.x0 > 100 && c.x0 < VALUE_X).map((c) => c.str.trim()).join(' ').replace(/\s+/g, ' ')

      if (section === 'international') {
        if (date) intlDate = isoOf(date[1], date[2])
        if (!valueCell || !intlDate || /^(dólar de conversão|valor em dólar)$/i.test(desc) || date) continue
      } else if (!date || !valueCell) continue

      const purchase = section === 'international' ? intlDate! : isoOf(date![1], date![2])
      if (!purchase) { warnings.push(`Data não reconhecida: ${line}`); continue }
      const value = brl(valueCell.str)
      const payment = section === 'previous'
      let estab = desc
      const p = payment ? null : PARCEL.exec(estab)
      if (p) estab = estab.slice(0, p.index).trim()
      const k = p ? Number(p[1]) : 1
      transactions.push({
        accountRef,
        bookingDate: p ? addMonths(purchase, k - 1) : purchase,
        valueDate: purchase,
        description: p ? `${estab} (${k}/${Number(p[2])})` : estab,
        amount: round2(-value), // purchases are shown positive, the payment as "- R$ 1.234,56"
        currency: 'BRL',
        bankCategory: payment ? CARD_PAYMENT : undefined,
        bankSubcategory: payment ? undefined : `cartão final ${holder}`,
        statementDue: dueDate,
      })
    }
  }

  if (/pr[óo]xima/.test(kind)) {
    warnings.push('Fatura próxima: só parcelas futuras — não importada.')
    return { source: 'itau_card_pdf', transactions: [], checkpoints: [], warnings, accounts }
  }

  const charges = round2(transactions.filter((t) => t.bankCategory !== CARD_PAYMENT).reduce((s, t) => s - t.amount, 0))
  const totalLine = flat.map((l) => /^total \(nacional \+ internacional \+ encargos\) R\$\s*([\d.]+,\d{2})$/.exec(l)).find(Boolean)
  const total = totalLine ? brl(`R$ ${totalLine[1]}`) : shown ? brl(`R$ ${shown[1]}`) : charges
  if (Math.abs(charges - total) > 0.05) warnings.push(`Soma dos lançamentos (${charges.toFixed(2)}) difere do total da fatura (${total.toFixed(2)}).`)

  const cardStatements: CardStatement[] = [{ accountRef, dueDate, status: kind === 'paga' ? 'paga' : 'aberta', total }]
  return { source: 'itau_card_pdf', transactions, checkpoints: [], warnings, accounts, cardStatements }
}
