/**
 * Audit of imports: which rows of a statement file are really in the database, and which
 * transfers between the user's own accounts lack the other side.
 *
 * The import's duplicate check is loose on purpose (same account, date, amount and one word in
 * common, or a fingerprint built from the first word only), so two different operations can be
 * taken for one: two "VIR …" of the same amount on the same day share a fingerprint. Here a row
 * only counts as stored when the description matches too; same date and amount with another
 * description is reported apart, with the stored row, for the user to judge.
 */
import type { ParsedTransaction } from './types'

export interface AuditStored { id: string; accountRef: string; accountName: string; date: string; amount: number; description: string }
/** ok: stored as is · similar: same account, date and amount, another description · missing · noAccount: the file's account is not registered. */
export type AuditStatus = 'ok' | 'similar' | 'missing' | 'noAccount'
export interface AuditRow { tx: ParsedTransaction; status: AuditStatus; match?: AuditStored }

const plain = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()
const key = (ref: string, date: string, amount: number) => `${ref}|${date}|${amount.toFixed(2)}`

/** Each stored row answers for one file row at most: two equal purchases need two stored rows. */
export function auditRows(parsed: ParsedTransaction[], stored: AuditStored[], knownRefs: Set<string>): AuditRow[] {
  const byKey = new Map<string, AuditStored[]>()
  for (const s of stored) {
    const k = key(s.accountRef, s.date, s.amount)
    byKey.set(k, [...(byKey.get(k) ?? []), s])
  }
  const used = new Set<string>()
  const out: AuditRow[] = parsed.map((tx) => ({ tx, status: knownRefs.has(tx.accountRef) ? 'missing' : 'noAccount' }))
  // Exact matches first, so a similar one never takes the row an exact one needed.
  for (const pass of ['ok', 'similar'] as const) {
    for (const r of out) {
      if (r.status !== 'missing') continue
      const hit = byKey.get(key(r.tx.accountRef, r.tx.bookingDate, r.tx.amount))
        ?.find((s) => !used.has(s.id) && (pass === 'similar' || plain(s.description) === plain(r.tx.description)))
      if (hit) { used.add(hit.id); r.status = pass; r.match = hit }
    }
  }
  return out
}

export interface PairTx { id: string; account_id: string; date: string; amount: number; currency: string; description: string; kind: string }

/**
 * Transfers without the other side in another of the user's accounts: money that left one
 * account should come into another, and the other way round. The other side is an opposite
 * amount in another account within `days` days (the same to the cent in the same currency, within
 * 3% across currencies, at the day's rate); transfers are preferred as the other side, and each
 * row answers for one transfer only.
 */
export function unpairedTransfers(txs: PairTx[], convert: (amount: number, from: string, to: string, date: string) => number, days = 5): PairTx[] {
  const DAY = 86_400_000
  const used = new Set<string>()
  const transfers = txs.filter((t) => t.kind === 'transfer' && Math.abs(t.amount) > 0.005).sort((a, b) => a.date.localeCompare(b.date))
  const matches = (t: PairTx, o: PairTx) => {
    if (o.account_id === t.account_id || Math.sign(o.amount) === Math.sign(t.amount)) return false
    if (Math.abs(Date.parse(o.date) - Date.parse(t.date)) > days * DAY) return false
    if (o.currency === t.currency) return Math.abs(o.amount + t.amount) < 0.01
    const v = convert(t.amount, t.currency, o.currency, t.date)
    return Math.abs(v + o.amount) <= 0.03 * Math.abs(o.amount)
  }
  const out: PairTx[] = []
  for (const t of transfers) {
    if (used.has(t.id)) continue
    const other = txs.filter((o) => !used.has(o.id) && matches(t, o))
      .sort((a, b) => Number(b.kind === 'transfer') - Number(a.kind === 'transfer') || Math.abs(Date.parse(a.date) - Date.parse(t.date)) - Math.abs(Date.parse(b.date) - Date.parse(t.date)))[0]
    if (other) { used.add(t.id); used.add(other.id) } else out.push(t)
  }
  return out
}

/** An import as the log keeps it; `skipped` only exists for imports logged with migration 007. */
export interface LogRecord {
  id: string; file_name: string; source: string; created_at: string; rows_total: number; rows_inserted: number
  skipped?: { date: string; account_ref: string; description: string; amount: number; currency: 'EUR' | 'BRL'; reason: string; matches?: string }[]
}
export interface LogAudit {
  record: LogRecord
  inBase: number // rows of this import in the database now
  notWritten: number // rows of the file the import did not write (taken for duplicates, or no account)
  lost: number // written according to the log but not in the database: dropped by it, or deleted since
  rows: (AuditRow & { reason: string; matches?: string })[] // the logged skipped rows, checked again
}

/**
 * Audit from the import log alone, without the files: per import, how many rows the file had,
 * how many were written and how many are in the database now; and, where the log keeps them,
 * each skipped row checked again against the database with the strict rule of auditRows.
 */
export function auditImportLog(records: LogRecord[], stored: (AuditStored & { importId?: string | null })[], knownRefs: Set<string>): LogAudit[] {
  const count = new Map<string, number>()
  for (const s of stored) if (s.importId) count.set(s.importId, (count.get(s.importId) ?? 0) + 1)
  return records.map((record) => {
    const inBase = count.get(record.id) ?? 0
    const skipped = record.skipped ?? []
    const checked = auditRows(skipped.map((k) => ({ accountRef: k.account_ref, bookingDate: k.date, description: k.description, amount: k.amount, currency: k.currency })), stored, knownRefs)
    return {
      record, inBase,
      notWritten: Math.max(0, record.rows_total - record.rows_inserted),
      lost: Math.max(0, record.rows_inserted - inBase),
      rows: checked.map((r, i) => ({ ...r, reason: skipped[i].reason, matches: skipped[i].matches })),
    }
  })
}

/** Category shown for a transfer with no other side in the user's accounts: money from or to outside. */
export const EXTERNAL = 'Transferência externa'

/**
 * Transfers whose other side is in none of the user's accounts are money that came from or went
 * outside (a savings account not in the app, someone else): they count as income or expense, in
 * the category EXTERNAL. Paired ones stay transfers. `skip`: transfers never turned (card bill
 * payments, whose purchases are already counted, and rows of card accounts).
 */
export function withExternalTransfers<T extends PairTx & { categoryName: string }>(txs: T[], convert: (amount: number, from: string, to: string, date: string) => number, skip: (t: T) => boolean): T[] {
  const ids = new Set(unpairedTransfers(txs, convert).filter((t) => !skip(t as T)).map((t) => t.id))
  if (!ids.size) return txs
  return txs.map((t) => (ids.has(t.id) ? { ...t, kind: t.amount > 0 ? 'income' : 'expense', categoryName: EXTERNAL } : t))
}
