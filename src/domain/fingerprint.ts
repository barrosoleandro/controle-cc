import type { ParsedTransaction } from './types'
import { merchantKey } from './categorize'

/**
 * The vendor as far as duplicate detection is concerned: the first word of the merchant
 * key ("CB CARREFOUR FACT 250426" and "CARREFOUR MARKET" → CARREFOUR). Banks word the
 * same operation differently in CSV, PDF and Excel; the first word is what they share.
 */
export function vendorToken(description: string): string {
  return merchantKey(description).split(' ')[0] ?? ''
}

/** Same account, date, amount and vendor = the same operation. */
export function dedupeKey(account: string, date: string, amount: number, description: string): string {
  return `${account}|${date}|${Number(amount).toFixed(2)}|${vendorToken(description)}`
}

/**
 * Deterministic key used to avoid duplicates when the same period is imported twice or
 * from two sources (CSV + PDF, Excel + PDF): account, booking date, amount, vendor and the
 * occurrence index of that combination inside the file, so two identical purchases on
 * the same day both stay.
 */
export function withFingerprints<T extends ParsedTransaction>(txs: T[], accountId: (ref: string) => string) {
  const seen = new Map<string, number>()
  return txs.map((t) => {
    const base = dedupeKey(accountId(t.accountRef), t.bookingDate, t.amount, t.description)
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return { ...t, fingerprint: `${base}|${n}` }
  })
}

/**
 * Which incoming rows already exist, whatever file they came from. Counted per key: if
 * one row with that account, date, amount and vendor is stored and the file has two,
 * the first is a duplicate and the second is new.
 */
export function markDuplicates(incomingKeys: string[], existingKeys: Iterable<string>): boolean[] {
  const stock = new Map<string, number>()
  for (const k of existingKeys) stock.set(k, (stock.get(k) ?? 0) + 1)
  return incomingKeys.map((k) => {
    const left = stock.get(k) ?? 0
    if (left > 0) { stock.set(k, left - 1); return true }
    return false
  })
}
