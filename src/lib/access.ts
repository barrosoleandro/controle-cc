// Chamadas à Edge Function "household-access" (supabase/functions/household-access) e a lista da casa.
import { supabase } from './supabase'
import { describeAgent } from '../domain/access'

/**
 * Chama a função; um erro vira o código que ela devolveu. Sem código próprio: 404 = função não
 * publicada, 401 = publicada com "Enforce JWT verification" ligado.
 */
async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('household-access', { body })
  if (!error) return data as T
  const res = (error as { context?: unknown }).context
  let code = ''
  if (res instanceof Response) {
    try { code = String((await res.json())?.error ?? '') } catch { /* corpo sem JSON */ }
    if (!code && res.status === 404) code = 'nao_publicada'
    if (!code && res.status === 401) code = 'jwt_ligado'
  }
  if (!code && error.name === 'FunctionsFetchError') code = 'nao_publicada'
  throw new Error(code || error.message)
}

export interface AccessStart { id: string; pairCode: string; pollSecret: string; matchCode: number; expiresAt: string }
export type AccessPoll = { status: 'pending' | 'denied' | 'expired' | 'used' } | { status: 'approved'; tokenHash: string }
export interface AccessInfo { email: string; requester: { os?: string; browser?: string; ip?: string }; createdAt: string; plan: string; choices: number[] }

export const startAccess = (email: string) => call<AccessStart>({ action: 'start', email, requester: describeAgent(navigator.userAgent) })
export const pollAccess = (s: AccessStart) => call<AccessPoll>({ action: 'poll', id: s.id, pollSecret: s.pollSecret })
export const accessInfo = (pairCode: string) => call<AccessInfo>({ action: 'info', pairCode })
export const approveAccess = (pairCode: string, match: number) => call<{ status: string; created: boolean }>({ action: 'approve', pairCode, match })
export const denyAccess = (pairCode: string) => call<{ status: string }>({ action: 'approve', pairCode, deny: true })
export const removeMember = (memberId: string) => call<{ status: string }>({ action: 'remove', memberId })

/** Aprovado: entra com o token de uso único. */
export async function signInWithToken(tokenHash: string): Promise<void> {
  const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' })
  if (error) throw new Error(error.message)
}

export interface Member { member_id: string; owner_id: string; email: string | null; created_at: string }
/** Vínculos visíveis para quem está logado (o dono vê os membros; o membro, o próprio). null antes da 011. */
export async function household(): Promise<Member[] | null> {
  const r = await supabase.from('household_members').select('member_id, owner_id, email, created_at').order('created_at')
  return r.error ? null : (r.data as Member[])
}
