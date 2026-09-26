import type { ParsedTransaction } from './types'

/**
 * Deterministic key used to avoid duplicates when the same period is imported twice
 * or from two sources (CSV + PDF). Built from account, booking date, amount and the
 * occurrence index of that (date, amount) pair inside the file — description-independent
 * because banks word the same operation differently in CSV and PDF.
 */
export function withFingerprints<T extends ParsedTransaction>(txs: T[], accountId: (ref: string) => string) {
  const seen = new Map<string, number>()
  return txs.map((t) => {
    const acc = accountId(t.accountRef)
    const base = `${acc}|${t.bookingDate}|${t.amount.toFixed(2)}`
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return { ...t, fingerprint: `${base}|${n}` }
  })
}
