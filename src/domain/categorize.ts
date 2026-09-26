import type { BankMapEntry, Rule } from './types'

export interface CategorizableTx {
  description: string
  amount: number
  bankCategory?: string | null
  bankSubcategory?: string | null
}

/**
 * bank_category given to a credit-card bill payment (on the card side). It moves money
 * between two of the user's own accounts, so it is always a transfer — never spending.
 */
export const CARD_PAYMENT = 'PAGAMENTO FATURA'
export const TRANSFER = 'Transfer'
/** Alphabetical order for category lists, ignoring case and accents ("Educação" next to "Educacao"). */
export const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' })

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()

/**
 * Returns the personal category name for a transaction.
 * Order: merchant rules (by priority) → bank category map (exact sub-category, then '*') → default.
 */
export function categorize(tx: CategorizableTx, rules: Rule[], bankMap: BankMapEntry[], bank = 'BCP'): string {
  if (tx.bankCategory === CARD_PAYMENT) return TRANSFER
  const sorted = [...rules].filter((r) => r.active !== false).sort((a, b) => a.priority - b.priority)
  for (const r of sorted) if (ruleMatches(r, tx, bank)) return r.category
  if (tx.bankCategory) {
    const exact = bankMap.find((m) => m.bank_category === tx.bankCategory && m.bank_subcategory === tx.bankSubcategory)
    if (exact) return exact.category
    const any = bankMap.find((m) => m.bank_category === tx.bankCategory && m.bank_subcategory === '*')
    if (any) return any.category
  }
  return tx.amount >= 0 ? 'Outras receitas' : 'Outros'
}

/** Whether one rule applies to a transaction (bank, sign and pattern). */
export function ruleMatches(r: Pick<Rule, 'pattern' | 'bank' | 'sign'>, tx: { description: string; amount: number }, bank = 'BCP'): boolean {
  if (r.bank && r.bank !== bank) return false
  if (r.sign === 'debit' && tx.amount >= 0) return false
  if (r.sign === 'credit' && tx.amount < 0) return false
  const desc = norm(tx.description)
  // Rules learned from merchantKey() hold letters only ("PAG SERV BANCO"); also try the
  // description without digits/punctuation so they still match "PAG SERV 21489/0209 BANCO".
  const letters = desc.replace(/[^A-Z ]+/g, ' ').replace(/\s+/g, ' ').trim()
  return patternMatches(desc, r.pattern) || patternMatches(letters, r.pattern)
}

/** Short merchant key used for grouping (subscriptions, top merchants). */
export function merchantKey(description: string): string {
  return norm(description)
    .replace(/^(CB|PRLV|PRLV SEPA|VIR SEPA|VIREMENT VERS|PIX QRS|PIX TRANSF|DA|PAG BOLETO|\*)\s+/, '')
    .replace(/\bFACT \d{6}\b.*$/, '')
    .replace(/\(EN [A-Z]{3} [\d,]+\)/, '')
    .replace(/\d{2}\/\d{2}$/, '')
    .replace(/[^A-Z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 3)
    .join(' ')
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Substring match that must start at a word boundary (so 'AXA' does not match 'TAXA'). */
export function patternMatches(normalizedDesc: string, pattern: string): boolean {
  return new RegExp(`(^|[^A-Z])${esc(norm(pattern))}`).test(normalizedDesc)
}
