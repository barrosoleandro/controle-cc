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

/** Account, date and amount: the bucket where two rows can be the same operation. */
export function dedupeKey(account: string, date: string, amount: number): string {
  return `${account}|${date}|${Number(amount).toFixed(2)}`
}

// Words that say how money moved, not who received it.
const GENERIC = new Set(['CARTE', 'VIR', 'PIX', 'TRANSF', 'SEPA', 'PRLV', 'FACT', 'COMPRA', 'CARTAO', 'DEBITO', 'CREDITO'])

/**
 * The vendor's words, in any order and without accents: "DI Resgate CDB" and "RESGATE CDB DI",
 * or "INT Pag Tít 033" and "PAG TIT INT 033", give the same words. Letters and digits are
 * split apart ("INT1660e50e" → INT, 1660) and short or generic words are dropped.
 */
export function vendorWords(description: string): Set<string> {
  const plain = description.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase()
  return new Set((plain.match(/[A-Z]+|\d+/g) ?? []).filter((w) => w.length >= 3 && !GENERIC.has(w)))
}

/** Same vendor when the descriptions share a word (or one of them has no usable word). */
export function sameVendor(a: string, b: string): boolean {
  const wa = vendorWords(a), wb = vendorWords(b)
  if (!wa.size || !wb.size) return true
  for (const w of wa) if (wb.has(w)) return true
  return false
}

export interface DupItem { key: string; desc: string }

/**
 * Which incoming rows already exist, whatever file they came from: same account, date and
 * amount (the key) and the same vendor (sameVendor). Each stored row absorbs at most one
 * incoming row, so two identical purchases in one statement both stay when only one is stored.
 */
export function markDuplicates(incoming: DupItem[], existing: DupItem[]): boolean[] {
  const byKey = new Map<string, { desc: string; used: boolean }[]>()
  for (const e of existing) {
    const list = byKey.get(e.key) ?? []
    list.push({ desc: e.desc, used: false })
    byKey.set(e.key, list)
  }
  return incoming.map((x) => {
    const hit = byKey.get(x.key)?.find((e) => !e.used && sameVendor(e.desc, x.desc))
    if (hit) hit.used = true
    return !!hit
  })
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
    const base = `${dedupeKey(accountId(t.accountRef), t.bookingDate, t.amount)}|${vendorToken(t.description)}`
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return { ...t, fingerprint: `${base}|${n}` }
  })
}
