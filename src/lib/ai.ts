import { supabase } from './supabase'
import type { AppData } from './data'
import type { Transaction } from '../domain/types'

/** One merchant sent for enrichment, described only by what the statement already shows. */
export interface VendorQuery {
  merchant: string
  samples: string[]
  bankCategory?: string | null
  bankSubcategory?: string | null
  sign: 'debit' | 'credit'
  currency: string
  typicalAmount?: number
}

export interface VendorSuggestion {
  merchant: string
  category: string | null // a name from the user's own list, or null when unsure
  description: string
  confidence: number
}

const CHUNK = 30 // merchants per call: keeps each response small and costs predictable

/**
 * Merchants worth asking about: no category, or a category nobody chose on purpose.
 * Sorted by how much money rides on them, so a truncated run still covers what matters.
 */
export function vendorsToEnrich(data: AppData, txs: Transaction[] = data.transactions): VendorQuery[] {
  const fallback = new Set(['Outros', 'Outras receitas'])
  const nameOf = new Map(data.categories.map((c) => [c.id, c.name]))
  const groups = new Map<string, { txs: Transaction[]; weight: number }>()
  for (const t of txs) {
    if (!t.merchant || t.merchant.length < 2) continue
    const name = t.category_id ? nameOf.get(t.category_id) : undefined
    const unknown = !t.category_id || (fallback.has(name ?? '') && !t.category_locked)
    if (!unknown) continue
    const g = groups.get(t.merchant) ?? { txs: [], weight: 0 }
    g.txs.push(t)
    g.weight += Math.abs(Number(t.amount))
    groups.set(t.merchant, g)
  }
  return [...groups]
    .sort((a, b) => b[1].weight - a[1].weight)
    .map(([merchant, g]) => {
      const last = g.txs[g.txs.length - 1]
      return {
        merchant,
        samples: [...new Set(g.txs.map((t) => t.description))].slice(0, 4),
        bankCategory: last.bank_category,
        bankSubcategory: last.bank_subcategory,
        sign: Number(last.amount) < 0 ? 'debit' : 'credit',
        currency: last.currency,
        typicalAmount: Math.round((g.weight / g.txs.length) * 100) / 100,
      } satisfies VendorQuery
    })
}

/**
 * Calls the enrich-transactions Edge Function. The Anthropic key lives there,
 * never in the browser — see supabase/functions/enrich-transactions/index.ts.
 */
export async function enrichVendors(
  vendors: VendorQuery[],
  categories: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<VendorSuggestion[]> {
  const out: VendorSuggestion[] = []
  for (let i = 0; i < vendors.length; i += CHUNK) {
    const chunk = vendors.slice(i, i + CHUNK)
    const { data, error } = await supabase.functions.invoke<{ results?: VendorSuggestion[]; error?: string }>(
      'enrich-transactions',
      { body: { vendors: chunk, categories } },
    )
    if (error) throw new Error(describeInvokeError(error))
    if (data?.error) throw new Error(data.error)
    out.push(...(data?.results ?? []))
    onProgress?.(Math.min(i + CHUNK, vendors.length), vendors.length)
  }
  return out
}

/** functions.invoke hides the body of a non-2xx response; say something useful instead. */
function describeInvokeError(error: unknown): string {
  const msg = (error as Error).message ?? String(error)
  if (/Failed to send a request|Failed to fetch/i.test(msg))
    return 'Não foi possível chamar a função enrich-transactions. Ela já foi publicada? (supabase functions deploy enrich-transactions)'
  return msg
}

export interface MerchantProfile {
  merchant: string
  description: string
  suggested_category_id: string | null
  confidence: number | null
  source: 'ai' | 'manual'
  accepted: boolean
}

export async function loadMerchantProfiles(): Promise<Map<string, MerchantProfile>> {
  const { data, error } = await supabase.from('merchant_profiles').select('*')
  if (error) throw new Error(faltaTabela(error.message))
  return new Map((data as MerchantProfile[]).map((p) => [p.merchant, p]))
}

/** Stores what the AI said, so the next import already knows this merchant. */
export async function saveMerchantProfiles(rows: Omit<MerchantProfile, 'accepted'>[], accepted = false) {
  if (!rows.length) return
  const payload = rows.map((r) => ({ ...r, accepted, updated_at: new Date().toISOString() }))
  for (let i = 0; i < payload.length; i += 200) {
    const { error } = await supabase.from('merchant_profiles').upsert(payload.slice(i, i + 200), { onConflict: 'user_id,merchant' })
    if (error) throw new Error(faltaTabela(error.message))
  }
}

/** A migration 003 pode não ter sido rodada ainda; diga o que fazer em vez do erro cru. */
function faltaTabela(msg: string): string {
  return /merchant_profiles/.test(msg)
    ? 'Tabela merchant_profiles não encontrada: rode supabase/migrations/003_merchant_profiles.sql no SQL Editor do Supabase.'
    : msg
}
