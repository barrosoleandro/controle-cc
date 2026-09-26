import { supabase } from './supabase'
import type { Account, BankMapEntry, Category, Currency, ParseResult, Rule, Transaction } from '../domain/types'
import { DEFAULT_BANK_MAP, DEFAULT_CATEGORIES, DEFAULT_RULES } from '../domain/defaults'
import { categorize, merchantKey } from '../domain/categorize'
import { withFingerprints } from '../domain/fingerprint'

export interface DashboardPrefs { widgets: { id: string; visible: boolean }[] }
export interface Settings { display_currency: Currency; dashboard: DashboardPrefs; dismissed_alerts: string[] }
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

export async function loadAll(): Promise<AppData> {
  const [accounts, categories, rulesRaw, mapRaw, transactions, checkpoints, budgets, fxRows, settingsRows, scenarios] = await Promise.all([
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

export interface ImportPlan {
  fileName: string
  sha256: string
  result: ParseResult
  unknownRefs: string[]
  newRows: number
  dupRows: number
}

export async function sha256(bytes: Uint8Array) {
  const h = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function planImport(fileName: string, hash: string, result: ParseResult, data: AppData): ImportPlan {
  const refs = new Set(data.accounts.map((a) => a.external_ref))
  const known = new Set(data.transactions.map((t) => t.fingerprint))
  const fp = withFingerprints(result.transactions, (r) => r)
  const unknownRefs = [...new Set([...result.transactions, ...result.checkpoints].map((t) => t.accountRef))].filter((r) => r && !refs.has(r))
  const newRows = fp.filter((t) => !known.has(t.fingerprint)).length
  return { fileName, sha256: hash, result, unknownRefs, newRows, dupRows: fp.length - newRows }
}

/** Writes the parsed file: new transactions (categorized), bank balances, import log. */
export async function executeImport(plan: ImportPlan, data: AppData): Promise<number> {
  const accByRef = new Map(data.accounts.map((a) => [a.external_ref, a]))
  const catId = new Map(data.categories.map((c) => [c.name, c.id]))
  const known = new Set(data.transactions.map((t) => t.fingerprint))
  const imp = must(await supabase.from('imports').insert({
    file_name: plan.fileName, file_sha256: plan.sha256, source: plan.result.source,
    rows_total: plan.result.transactions.length, rows_inserted: 0,
  }).select().single()) as { id: string }
  const rows = withFingerprints(plan.result.transactions, (r) => r)
    .filter((t) => !known.has(t.fingerprint) && accByRef.has(t.accountRef))
    .map((t) => {
      const acc = accByRef.get(t.accountRef)!
      return {
        account_id: acc.id, booking_date: t.bookingDate, value_date: t.valueDate ?? null,
        description: t.description, merchant: merchantKey(t.description), amount: t.amount, currency: t.currency,
        bank_category: t.bankCategory ?? null, bank_subcategory: t.bankSubcategory ?? null,
        category_id: catId.get(categorize(t, data.rules, data.bankMap, acc.bank)) ?? null,
        source: plan.result.source, fingerprint: t.fingerprint, import_id: imp.id,
      }
    })
  for (let i = 0; i < rows.length; i += 500)
    must(await supabase.from('transactions').upsert(rows.slice(i, i + 500), { onConflict: 'user_id,fingerprint', ignoreDuplicates: true }))
  const cps = plan.result.checkpoints.filter((c) => accByRef.has(c.accountRef)).map((c) => ({
    account_id: accByRef.get(c.accountRef)!.id, date: c.date, balance: c.balance, source: plan.result.source,
  }))
  if (cps.length) must(await supabase.from('balance_checkpoints').upsert(cps, { onConflict: 'account_id,date' }))
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
export async function createAccount(a: Omit<Account, 'id' | 'opening_balance' | 'opening_date' | 'is_active'>) {
  must(await supabase.from('accounts').insert(a))
}
export async function setTransactionCategory(id: string, category_id: string | null, locked = true) {
  must(await supabase.from('transactions').update({ category_id, category_locked: locked }).eq('id', id))
}
export async function setTransactionNote(id: string, notes: string) {
  must(await supabase.from('transactions').update({ notes }).eq('id', id))
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

export async function addRule(pattern: string, category_id: string, sign: 'debit' | 'credit' | null, priority: number) {
  must(await supabase.from('category_rules').insert({ pattern, category_id, sign, priority }))
}
export async function deleteRule(id: string) { must(await supabase.from('category_rules').delete().eq('id', id)) }
export async function updateRule(id: string, patch: Record<string, unknown>) { must(await supabase.from('category_rules').update(patch).eq('id', id)) }
export async function updateBankMap(id: string, category_id: string) { must(await supabase.from('bank_category_map').update({ category_id }).eq('id', id)) }
export async function addCategory(name: string, kind: Category['kind'], color: string, sort: number) {
  must(await supabase.from('categories').insert({ name, kind, color, sort }))
}
export async function updateCategory(id: string, patch: Partial<Category>) { must(await supabase.from('categories').update(patch).eq('id', id)) }
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
