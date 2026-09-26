import { supabase } from './supabase'
import type { Account, AccountHint, BankMapEntry, Category, Currency, ParseResult, ParsedTransaction, Rule, Transaction } from '../domain/types'
import { DEFAULT_BANK_MAP, DEFAULT_CATEGORIES, DEFAULT_RULES } from '../domain/defaults'
import { categorize, merchantKey, ruleMatches, TRANSFER } from '../domain/categorize'
import { matchCardPayments, type StoredCardStatement } from '../domain/cards'
import { dedupeKey, markDuplicates, withFingerprints } from '../domain/fingerprint'
import { withAiNote } from '../domain/claudeExchange'
import type { ContractItem } from '../domain/payroll'

export interface DashboardPrefs {
  widgets: { id: string; visible: boolean }[]
  /** Payslips: country the salary is paid in, and the inflation table used per country. */
  payroll?: { country?: string; inflation?: Record<string, Record<string, number>> }
}
export interface Settings { display_currency: Currency; dashboard: DashboardPrefs; dismissed_alerts: string[]; payroll_contract?: ContractItem[] | null }
export interface Checkpoint { account_id: string; date: string; balance: number; source: string }
export interface Budget { category_id: string; month: string | null; amount: number }
export interface StoredRule extends Rule { id: string; category_id: string }
export interface StoredBankMap extends BankMapEntry { id: string; category_id: string }
export interface ScenarioRow { id: string; name: string; data: unknown }

export interface AppData {
  accounts: Account[]
  categories: Category[]
  rules: StoredRule[]
  bankMap: StoredBankMap[]
  transactions: Transaction[]
  checkpoints: Checkpoint[]
  budgets: Budget[]
  fx: Map<string, number>
  settings: Settings
  scenarios: ScenarioRow[]
  cardStatements: StoredCardStatement[]
}

const must = <T>(r: { data: T | null; error: { message: string } | null }): T => {
  if (r.error) throw new Error(r.error.message)
  return r.data as T
}

async function selectAll<T>(table: string, order: string): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += 1000) {
    const page = must(await supabase.from(table).select('*').order(order).range(from, from + 999)) as T[]
    out.push(...page)
    if (page.length < 1000) return out
  }
}

/** Tables added by later migrations: the app keeps working (without the feature) until they are run. */
async function selectOptional<T>(table: string, order: string): Promise<T[]> {
  try { return await selectAll<T>(table, order) } catch { return [] }
}

export async function loadAll(): Promise<AppData> {
  const [accounts, categories, rulesRaw, mapRaw, transactions, checkpoints, budgets, fxRows, settingsRows, scenarios, cardStatements] = await Promise.all([
    selectAll<Account>('accounts', 'name'),
    selectAll<Category>('categories', 'sort'),
    selectAll<{ id: string; pattern: string; bank: string | null; sign: 'debit' | 'credit' | null; category_id: string; priority: number; active: boolean }>('category_rules', 'priority'),
    selectAll<{ id: string; bank: string; bank_category: string; bank_subcategory: string; category_id: string }>('bank_category_map', 'bank_category'),
    selectAll<Transaction>('transactions', 'booking_date'),
    selectAll<Checkpoint>('balance_checkpoints', 'date'),
    selectAll<Budget>('budgets', 'category_id'),
    selectAll<{ date: string; quote: string; rate: number }>('fx_rates', 'date'),
    selectAll<Settings>('user_settings', 'updated_at'),
    selectAll<ScenarioRow>('scenarios', 'name'),
    selectOptional<StoredCardStatement>('card_statements', 'due_date'),
  ])
  const catName = new Map(categories.map((c) => [c.id, c.name]))
  return {
    accounts: accounts.map((a) => ({ ...a, opening_balance: Number(a.opening_balance) })),
    categories,
    rules: rulesRaw.map((r) => ({ ...r, category: catName.get(r.category_id) ?? '' })),
    bankMap: mapRaw.map((m) => ({ ...m, category: catName.get(m.category_id) ?? '' })),
    transactions: transactions.map((t) => ({ ...t, amount: Number(t.amount) })),
    checkpoints: checkpoints.map((c) => ({ ...c, balance: Number(c.balance) })),
    budgets: budgets.map((b) => ({ ...b, amount: Number(b.amount) })),
    fx: new Map(fxRows.filter((r) => r.quote === 'BRL').map((r) => [r.date, Number(r.rate)])),
    settings: settingsRows[0] ?? { display_currency: 'EUR', dashboard: { widgets: [] }, dismissed_alerts: [] },
    scenarios,
    cardStatements: cardStatements.map((c) => ({ ...c, total: Number(c.total) })),
  }
}

/** First login: creates the default categories, budgets, rules, bank map and accounts. */
export async function seedDefaults() {
  const cats = must(await supabase.from('categories').insert(
    DEFAULT_CATEGORIES.map((c, i) => ({ name: c.name, kind: c.kind, color: c.color, sort: i })),
  ).select()) as Category[]
  const id = new Map(cats.map((c) => [c.name, c.id]))
  must(await supabase.from('budgets').insert(
    DEFAULT_CATEGORIES.filter((c) => c.budget !== undefined).map((c) => ({ category_id: id.get(c.name), month: null, amount: c.budget })),
  ))
  must(await supabase.from('category_rules').insert(
    DEFAULT_RULES.map((r) => ({ pattern: r.pattern, bank: r.bank, sign: r.sign, priority: r.priority, category_id: id.get(r.category) })),
  ))
  must(await supabase.from('bank_category_map').insert(
    DEFAULT_BANK_MAP.map((m) => ({ bank: m.bank, bank_category: m.bank_category, bank_subcategory: m.bank_subcategory, category_id: id.get(m.category) })),
  ))
  must(await supabase.from('accounts').insert([
    { name: 'BCP Conta Conjunta', bank: 'BCP', currency: 'EUR', type: 'checking', external_ref: '04033573329' },
    { name: 'BCP Livret A', bank: 'BCP', currency: 'EUR', type: 'savings', external_ref: '00033573316' },
    { name: 'BCP LDDS', bank: 'BCP', currency: 'EUR', type: 'savings', external_ref: '06036365166' },
    { name: 'Itaú Conta', bank: 'ITAU', currency: 'BRL', type: 'checking', external_ref: '7824/007765-0' },
  ]))
  must(await supabase.from('user_settings').upsert({ display_currency: 'EUR' }))
}

/** A parsed row that matches one already stored (or in an earlier file of the same selection). */
export interface DupRow {
  id: string // unique in the selection: file name + fingerprint
  tx: ParsedTransaction & { fingerprint: string }
  matches: string // what it matches, for the user to decide
}

export interface ImportPlan {
  fileName: string
  sha256: string
  result: ParseResult
  unknownRefs: string[]
  newRows: number
  dupRows: number
  duplicates: DupRow[]
}

export async function sha256(bytes: Uint8Array) {
  const h = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export interface ImportRecord {
  id: string
  file_name: string
  file_sha256: string
  source: string
  rows_total: number
  rows_inserted: number
  created_at: string
}

export async function listImports(): Promise<ImportRecord[]> {
  return (await selectAll<ImportRecord>('imports', 'created_at')).reverse()
}

/**
 * Undoes file imports: deletes the rows each file created, the card bills read from it and
 * its import record, so the file can be imported again. Rows another file already had are
 * not touched (they belong to that other import). Bank balances read from the file stay:
 * they are the bank's own figures and a new import overwrites them.
 */
export async function undoImports(recs: ImportRecord[]): Promise<number> {
  let deleted = 0
  for (let i = 0; i < recs.length; i += 50) {
    const ids = recs.slice(i, i + 50).map((r) => r.id)
    const rows = must(await supabase.from('transactions').delete().in('import_id', ids).select('id')) as { id: string }[]
    deleted += rows.length
    const names = recs.slice(i, i + 50).map((r) => r.file_name)
    await supabase.from('card_statements').delete().in('file_name', names) // table from migration 004; optional
    must(await supabase.from('imports').delete().in('id', ids))
  }
  return deleted
}

/** SHA-256 of every file already imported, so the same file is never imported twice. */
export async function importedHashes(): Promise<Set<string>> {
  const rows = await selectAll<{ file_sha256: string }>('imports', 'created_at')
  return new Set(rows.map((r) => r.file_sha256))
}

/**
 * Rows of a parsed file that are not stored yet. A row counts as already stored when the
 * same account has a row with the same date, amount and vendor, whatever file it came
 * from (see markDuplicates), or the same fingerprint.
 */
function newRowsOf(result: ParseResult, data: AppData, pending: { key: string; label: string }[] = []) {
  const refOf = new Map(data.accounts.map((a) => [a.id, a.external_ref]))
  const stored = data.transactions.map((t) => ({
    key: dedupeKey(refOf.get(t.account_id) ?? '', t.booking_date, Number(t.amount), t.description),
    label: `já na base: ${t.booking_date} · ${t.description} · ${Number(t.amount).toFixed(2)}`,
  }))
  const pool = [...stored, ...pending]
  const labelOf = new Map<string, string>()
  for (const x of pool) if (!labelOf.has(x.key)) labelOf.set(x.key, x.label)
  const known = new Set(data.transactions.map((t) => t.fingerprint))
  const fp = withFingerprints(result.transactions, (r) => r)
  const keys = fp.map((t) => dedupeKey(t.accountRef, t.bookingDate, t.amount, t.description))
  const dup = markDuplicates(keys, pool.map((x) => x.key))
  const fresh = fp.filter((t, i) => !dup[i] && !known.has(t.fingerprint))
  const dups = fp.map((t, i) => ({ t, i })).filter(({ t, i }) => dup[i] || known.has(t.fingerprint))
    .map(({ t, i }) => ({ tx: t, key: keys[i], matches: labelOf.get(keys[i]) ?? 'mesmo lançamento já importado' }))
  return { fresh, dups, keys: fresh.map((t) => dedupeKey(t.accountRef, t.bookingDate, t.amount, t.description)) }
}

/**
 * `pending`: rows of earlier files in the same selection, so a repeat between two new
 * files is also shown to the user before anything is written.
 */
export function planImport(fileName: string, hash: string, result: ParseResult, data: AppData, pending: { key: string; label: string }[] = []): ImportPlan {
  const refs = new Set(data.accounts.map((a) => a.external_ref))
  const unknownRefs = [...new Set([...result.transactions, ...result.checkpoints].map((t) => t.accountRef))].filter((r) => r && !refs.has(r))
  const { fresh, dups } = newRowsOf(result, data, pending)
  return {
    fileName, sha256: hash, result, unknownRefs, newRows: fresh.length, dupRows: dups.length,
    duplicates: dups.map((d) => ({ id: `${fileName}#${d.tx.fingerprint}`, tx: d.tx, matches: d.matches })),
  }
}

/** Keys and labels of a plan's new rows, to check the next files of the same selection against. */
export function pendingOf(plan: ImportPlan): { key: string; label: string }[] {
  const dupFp = new Set(plan.duplicates.map((d) => d.tx.fingerprint))
  return withFingerprints(plan.result.transactions, (r) => r).filter((t) => !dupFp.has(t.fingerprint))
    .map((t) => ({ key: dedupeKey(t.accountRef, t.bookingDate, t.amount, t.description), label: `no arquivo ${plan.fileName}: ${t.bookingDate} · ${t.description} · ${t.amount.toFixed(2)}` }))
}

/**
 * Writes the parsed file: new transactions (categorized), bank balances, import log.
 * `forced`: ids of duplicate rows the user chose to import anyway.
 */
export async function executeImport(plan: ImportPlan, data: AppData, forced: Set<string> = new Set()): Promise<number> {
  const accByRef = new Map(data.accounts.map((a) => [a.external_ref, a]))
  const catId = new Map(data.categories.map((c) => [c.name, c.id]))
  const imp = must(await supabase.from('imports').insert({
    file_name: plan.fileName, file_sha256: plan.sha256, source: plan.result.source,
    rows_total: plan.result.transactions.length, rows_inserted: 0,
  }).select().single()) as { id: string }
  // Rows the user chose to keep although they repeat get their own fingerprint.
  const kept = plan.duplicates.filter((d) => forced.has(d.id)).map((d, i) => ({ ...d.tx, fingerprint: `${d.tx.fingerprint}|mantida-${Date.now()}-${i}` }))
  const rows = [...newRowsOf(plan.result, data).fresh, ...kept]
    .filter((t) => accByRef.has(t.accountRef))
    .map((t) => {
      const acc = accByRef.get(t.accountRef)!
      return {
        account_id: acc.id, booking_date: t.bookingDate, value_date: t.valueDate ?? null,
        description: t.description, merchant: merchantKey(t.description), amount: t.amount, currency: t.currency,
        bank_category: t.bankCategory ?? null, bank_subcategory: t.bankSubcategory ?? null,
        category_id: catId.get(categorize(t, data.rules, data.bankMap, acc.bank)) ?? null,
        source: plan.result.source, fingerprint: t.fingerprint, import_id: imp.id,
        ...(t.statementDue ? { statement_due: t.statementDue } : {}), // column from migration 004
      }
    })
  for (let i = 0; i < rows.length; i += 500) {
    const r = await supabase.from('transactions').upsert(rows.slice(i, i + 500), { onConflict: 'user_id,fingerprint', ignoreDuplicates: true })
    if (r.error) throw new Error(needs004(r.error.message))
  }
  const cps = plan.result.checkpoints.filter((c) => accByRef.has(c.accountRef)).map((c) => ({
    account_id: accByRef.get(c.accountRef)!.id, date: c.date, balance: c.balance, source: plan.result.source,
  }))
  if (cps.length) must(await supabase.from('balance_checkpoints').upsert(cps, { onConflict: 'account_id,date' }))
  const bills = (plan.result.cardStatements ?? []).filter((c) => accByRef.has(c.accountRef)).map((c) => ({
    account_id: accByRef.get(c.accountRef)!.id, due_date: c.dueDate, total: c.total, status: c.status,
    file_name: plan.fileName, updated_at: new Date().toISOString(),
  }))
  if (bills.length) {
    const r = await supabase.from('card_statements').upsert(bills, { onConflict: 'account_id,due_date' })
    if (r.error) throw new Error(needs004(r.error.message))
  }
  must(await supabase.from('imports').update({ rows_inserted: rows.length }).eq('id', imp.id))
  return rows.length
}

/**
 * Opening balance = earliest bank balance on/after the first transaction − transactions up to it.
 * This is what makes the rebuilt balance match the bank statements.
 */
export function deriveOpening(account: Account, txs: Transaction[], cps: Checkpoint[]) {
  const list = txs.filter((t) => t.account_id === account.id)
  const mine = cps.filter((c) => c.account_id === account.id).sort((a, b) => a.date.localeCompare(b.date))
  if (!list.length || !mine.length) return null
  const firstTx = list.reduce((m, t) => (t.booking_date < m ? t.booking_date : m), list[0].booking_date)
  const cp = mine.find((c) => c.date >= firstTx) ?? mine[0]
  const sum = list.filter((t) => t.booking_date <= cp.date).reduce((s, t) => s + Number(t.amount), 0)
  const d = new Date(Date.parse(firstTx) - 86400000).toISOString().slice(0, 10)
  return { opening_balance: Math.round((cp.balance - sum) * 100) / 100, opening_date: d }
}

export async function updateAccount(id: string, patch: Partial<Account>) {
  must(await supabase.from('accounts').update(patch).eq('id', id))
}
export async function createAccount(a: Omit<Account, 'id' | 'opening_balance' | 'opening_date' | 'is_active'>): Promise<Account> {
  const r = await supabase.from('accounts').insert(a).select().single()
  if (r.error) throw new Error(needs004(r.error.message))
  return r.data as Account
}

function needs004(msg: string): string {
  return /card_statements|statement_due|parent_account_id/.test(msg)
    ? 'Cartões ainda não habilitados no banco: rode supabase/migrations/004_cards.sql no SQL Editor do Supabase.'
    : msg
}

/** Fallback when a file names an account but brings no hint (older parsers). */
function guessHint(ref: string): AccountHint {
  const isItau = ref.includes('/')
  return { ref, name: `${isItau ? 'Itaú' : 'BCP'} ${ref}`, bank: isItau ? 'ITAU' : 'BCP', currency: isItau ? 'BRL' : 'EUR', type: 'checking' }
}

/**
 * Creates the accounts the files refer to and links each card to the account that pays it.
 * Bank accounts first, so a card created in the same run can point at its parent.
 */
export async function ensureAccounts(plans: ImportPlan[], data: AppData): Promise<number> {
  const hints = new Map<string, AccountHint>()
  for (const p of plans) for (const h of p.result.accounts ?? []) hints.set(h.ref, h)
  const byRef = new Map(data.accounts.map((a) => [a.external_ref, a]))
  const wanted = [...new Set(plans.flatMap((p) => p.unknownRefs))].filter((ref) => !byRef.has(ref)).map((ref) => hints.get(ref) ?? guessHint(ref))
  let created = 0
  for (const h of wanted.sort((a, b) => Number(a.type === 'card') - Number(b.type === 'card'))) {
    const parent = h.parentRef ? byRef.get(h.parentRef) : undefined
    const acc = await createAccount({
      name: h.name, bank: h.bank, currency: h.currency, type: h.type, external_ref: h.ref,
      ...(parent ? { parent_account_id: parent.id } : {}),
    })
    byRef.set(h.ref, acc)
    created++
  }
  // Cards that already existed but were never linked.
  for (const h of hints.values()) {
    const acc = byRef.get(h.ref), parent = h.parentRef ? byRef.get(h.parentRef) : undefined
    if (acc && parent && !acc.parent_account_id) await updateAccount(acc.id, { parent_account_id: parent.id })
  }
  return created
}

/**
 * Turns each matched bill payment in the paying account into a transfer (see
 * matchCardPayments). Locked, so "Reaplicar regras" keeps it. Returns how many changed.
 */
export async function linkCardPayments(data: AppData): Promise<number> {
  const transfer = data.categories.find((c) => c.name === TRANSFER)
  if (!transfer) return 0
  const ids = matchCardPayments(data.accounts, data.transactions)
    .map((m) => data.transactions.find((t) => t.id === m.bankTx.id)!)
    .filter((t) => t.category_id !== transfer.id)
    .map((t) => t.id)
  if (ids.length) await setCategoryForTransactions(ids, transfer.id)
  return ids.length
}
export async function setTransactionCategory(id: string, category_id: string | null, locked = true) {
  must(await supabase.from('transactions').update({ category_id, category_locked: locked }).eq('id', id))
}
/** Categorizes a whole merchant at once; locked so re-applying rules keeps the choice. */
export async function setCategoryForTransactions(ids: string[], category_id: string) {
  for (let i = 0; i < ids.length; i += 500)
    must(await supabase.from('transactions').update({ category_id, category_locked: true }).in('id', ids.slice(i, i + 500)))
}
export async function setTransactionNote(id: string, notes: string) {
  must(await supabase.from('transactions').update({ notes }).eq('id', id))
}
/**
 * A category picked for a merchant applies to its whole history, even rows chosen earlier by
 * hand or by the AI, and becomes (or updates) the merchant's rule. Returns the rows changed.
 */
export async function setMerchantCategory(data: AppData, merchant: string, categoryId: string): Promise<number> {
  const same = data.transactions.filter((x) => x.merchant === merchant)
  await setCategoryForTransactions(same.map((x) => x.id), categoryId)
  await markAiNote(same, false)
  const rule = data.rules.find((r) => r.pattern.toUpperCase() === merchant.toUpperCase())
  if (rule?.id) await updateRule(rule.id, { category_id: categoryId })
  else await addRule(merchant, categoryId, null, Math.min(1000, ...data.rules.map((r) => r.priority)) - 1) // regras suas vencem as padrão
  // Other descriptions the new rule now catches (not chosen by hand) follow too.
  return same.length + (await refreshCategories())
}

/** Adds (on) or removes the "defined by AI" marker in the notes of these transactions. */
export async function markAiNote(txs: Pick<Transaction, 'id' | 'notes'>[], on: boolean) {
  const byNotes = new Map<string, string[]>()
  for (const t of txs) {
    const next = withAiNote(t.notes, on)
    if (next !== (t.notes ?? '')) byNotes.set(next, [...(byNotes.get(next) ?? []), t.id])
  }
  for (const [notes, ids] of byNotes)
    for (let i = 0; i < ids.length; i += 500)
      must(await supabase.from('transactions').update({ notes: notes || null }).in('id', ids.slice(i, i + 500)))
}

/** Re-runs the rules on every transaction not categorized by hand. Returns number changed. */
export async function reapplyRules(data: AppData): Promise<number> {
  const catId = new Map(data.categories.map((c) => [c.name, c.id]))
  const bankOf = new Map(data.accounts.map((a) => [a.id, a.bank]))
  const changed = data.transactions.filter((t) => !t.category_locked).map((t) => ({
    t, cid: catId.get(categorize({ description: t.description, amount: t.amount, bankCategory: t.bank_category, bankSubcategory: t.bank_subcategory }, data.rules, data.bankMap, bankOf.get(t.account_id))) ?? null,
  })).filter((x) => x.cid !== x.t.category_id)
  // Upsert of full rows = one round trip per 500 rows instead of one per transaction.
  for (let i = 0; i < changed.length; i += 500) {
    const rows = changed.slice(i, i + 500).map(({ t, cid }) => ({ ...t, category_id: cid }))
    must(await supabase.from('transactions').upsert(rows, { onConflict: 'id' }))
  }
  return changed.length
}

/** Re-reads rules and bank map and re-runs them on every row not chosen by hand. Returns rows changed. */
export async function refreshCategories(): Promise<number> {
  return reapplyRules(await loadAll())
}

/**
 * A rule now points to another category. Rows it matches that still carry the old category
 * move with it, even locked ones (they were set for that merchant); rows deliberately put
 * elsewhere stay. Then the whole base is re-run. Returns rows changed.
 */
export async function changeRuleCategory(data: AppData, rule: StoredRule, categoryId: string): Promise<number> {
  must(await supabase.from('category_rules').update({ category_id: categoryId }).eq('id', rule.id))
  const bankOf = new Map(data.accounts.map((a) => [a.id, a.bank]))
  const ids = data.transactions.filter((t) => t.category_id === rule.category_id && ruleMatches(rule, t, bankOf.get(t.account_id))).map((t) => t.id)
  for (let i = 0; i < ids.length; i += 500)
    must(await supabase.from('transactions').update({ category_id: categoryId }).in('id', ids.slice(i, i + 500)))
  return ids.length + (await refreshCategories())
}

export async function addRule(pattern: string, category_id: string, sign: 'debit' | 'credit' | null, priority: number) {
  must(await supabase.from('category_rules').insert({ pattern, category_id, sign, priority }))
}
export async function deleteRule(id: string) { must(await supabase.from('category_rules').delete().eq('id', id)) }
export async function updateRule(id: string, patch: Record<string, unknown>) { must(await supabase.from('category_rules').update(patch).eq('id', id)) }
export async function updateBankMap(id: string, category_id: string) { must(await supabase.from('bank_category_map').update({ category_id }).eq('id', id)) }
/** Returns the created row so the caller can select the new category right away. */
export async function addCategory(name: string, kind: Category['kind'], color: string, sort: number): Promise<Category> {
  return must(await supabase.from('categories').insert({ name, kind, color, sort }).select().single()) as Category
}
export async function updateCategory(id: string, patch: Partial<Category>) { must(await supabase.from('categories').update(patch).eq('id', id)) }

/**
 * Folds `fromIds` into `toId`: transactions (keeping hand-picked locks), rules, bank map,
 * AI memory and budgets (added up) move first, and only then are the old categories
 * deleted. Deleting first would drop their rules and leave their rows without a category.
 * Returns how many transactions moved.
 */
export async function mergeCategories(fromIds: string[], toId: string, budgets: Budget[]): Promise<number> {
  const from = fromIds.filter((id) => id !== toId)
  if (!from.length) return 0
  const moved = must(await supabase.from('transactions').update({ category_id: toId }).in('category_id', from).select('id')) as { id: string }[]
  must(await supabase.from('category_rules').update({ category_id: toId }).in('category_id', from))
  must(await supabase.from('bank_category_map').update({ category_id: toId }).in('category_id', from))
  // AI memory is optional (migration 003); a missing table must not stop the merge.
  await supabase.from('merchant_profiles').update({ suggested_category_id: toId }).in('suggested_category_id', from)
  const sums = new Map<string | null, number>()
  for (const b of budgets) if (b.category_id === toId || from.includes(b.category_id)) sums.set(b.month, (sums.get(b.month) ?? 0) + b.amount)
  for (const [month, amount] of sums)
    must(await supabase.from('budgets').upsert({ category_id: toId, month, amount }, { onConflict: 'user_id,category_id,month' }))
  must(await supabase.from('categories').delete().in('id', from))
  return moved.length
}
export async function setBudget(category_id: string, amount: number) {
  must(await supabase.from('budgets').upsert({ category_id, month: null, amount }, { onConflict: 'user_id,category_id,month' }))
}
export async function saveSettings(patch: Partial<Settings>) {
  must(await supabase.from('user_settings').upsert({ ...patch, updated_at: new Date().toISOString() }))
}
export async function saveFx(rates: Map<string, number>) {
  const rows = [...rates].map(([date, rate]) => ({ date, quote: 'BRL', rate }))
  for (let i = 0; i < rows.length; i += 500)
    must(await supabase.from('fx_rates').upsert(rows.slice(i, i + 500), { onConflict: 'user_id,date,quote' }))
}
export async function saveScenario(id: string | null, name: string, payload: unknown) {
  if (id) must(await supabase.from('scenarios').update({ name, data: payload, updated_at: new Date().toISOString() }).eq('id', id))
  else must(await supabase.from('scenarios').insert({ name, data: payload }))
}
export async function deleteScenario(id: string) { must(await supabase.from('scenarios').delete().eq('id', id)) }
