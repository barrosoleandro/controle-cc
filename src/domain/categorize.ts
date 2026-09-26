import type { BankMapEntry, Rule } from './types'

export interface CategorizableTx {
  description: string
  amount: number
  bankCategory?: string | null
  bankSubcategory?: string | null
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()

/**
 * Returns the personal category name for a transaction.
 * Order: merchant rules (by priority) → bank category map (exact sub-category, then '*') → default.
 */
export function categorize(tx: CategorizableTx, rules: Rule[], bankMap: BankMapEntry[], bank = 'BCP'): string {
  const desc = norm(tx.description)
  const sorted = [...rules].filter((r) => r.active !== false).sort((a, b) => a.priority - b.priority)
  for (const r of sorted) {
    if (r.bank && r.bank !== bank) continue
    if (r.sign === 'debit' && tx.amount >= 0) continue
    if (r.sign === 'credit' && tx.amount < 0) continue
    if (patternMatches(desc, r.pattern)) return r.category
  }
  if (tx.bankCategory) {
    const exact = bankMap.find((m) => m.bank_category === tx.bankCategory && m.bank_subcategory === tx.bankSubcategory)
    if (exact) return exact.category
    const any = bankMap.find((m) => m.bank_category === tx.bankCategory && m.bank_subcategory === '*')
    if (any) return any.category
  }
  return tx.amount >= 0 ? 'Outras receitas' : 'Outros'
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
