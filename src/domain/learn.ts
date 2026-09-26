import { categorize, type CategorizableTx } from './categorize'
import type { BankMapEntry, Rule } from './types'

/** A stored transaction reduced to what learning needs. */
export interface LearnTx extends CategorizableTx {
  merchant: string
  bank: string
  categoryId: string | null
  categoryLocked: boolean
}

export interface RuleSuggestion {
  pattern: string // merchant key, used as the rule pattern
  categoryId: string
  categoryName: string
  support: number // charges already in the winning category
  total: number // categorized charges of this merchant
  confidence: number // support / total
  locked: number // how many of those were hand-picked
  wouldFix: number // charges the current rules get wrong today
}

export interface LearnOptions {
  minSupport?: number
  minConfidence?: number
  /** Only learn from merchants where at least one category was chosen by hand. */
  requireLocked?: boolean
}

const MAX_PATTERN = 100 // category_rules.pattern check constraint

/**
 * Turns categorization history into merchant rules, so the next import repeats the
 * choices already made by hand instead of falling back to "Outros".
 *
 * A merchant is only suggested when the history agrees with itself, a hand-picked
 * choice backs it, and the current rules would still get it wrong.
 */
export function suggestRules(
  txs: LearnTx[],
  rules: Rule[],
  bankMap: BankMapEntry[],
  nameOf: (categoryId: string) => string | undefined,
  { minSupport = 2, minConfidence = 0.75, requireLocked = true }: LearnOptions = {},
): RuleSuggestion[] {
  const groups = new Map<string, LearnTx[]>()
  for (const t of txs) {
    if (t.merchant.length < 2 || t.merchant.length > MAX_PATTERN) continue
    const g = groups.get(t.merchant) ?? []
    g.push(t)
    groups.set(t.merchant, g)
  }
  // A merchant already covered by a rule of its own is nothing new to learn.
  const covered = new Set(rules.filter((r) => r.active !== false).map((r) => r.pattern.toUpperCase()))
  const out: RuleSuggestion[] = []
  for (const [merchant, list] of groups) {
    if (covered.has(merchant.toUpperCase())) continue
    const known = list.filter((t) => t.categoryId)
    if (known.length < minSupport) continue
    const counts = new Map<string, number>()
    for (const t of known) counts.set(t.categoryId!, (counts.get(t.categoryId!) ?? 0) + 1)
    const [categoryId, support] = [...counts].sort((a, b) => b[1] - a[1])[0]
    const confidence = support / known.length
    if (confidence < minConfidence) continue
    const locked = known.filter((t) => t.categoryId === categoryId && t.categoryLocked).length
    if (requireLocked && locked === 0) continue
    const categoryName = nameOf(categoryId)
    if (!categoryName) continue
    const wouldFix = list.filter((t) => categorize(t, rules, bankMap, t.bank) !== categoryName).length
    if (!wouldFix) continue
    out.push({ pattern: merchant, categoryId, categoryName, support, total: known.length, confidence, locked, wouldFix })
  }
  return out.sort((a, b) => b.wouldFix - a.wouldFix || b.support - a.support || a.pattern.localeCompare(b.pattern))
}
