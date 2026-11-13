// Chamadas à Edge Function "qr-login" (supabase/functions/qr-login) e o estado local do acesso pontual.
import { supabase } from './supabase'
import { describeAgent } from '../domain/qrLogin'
import { noteSignedIn } from './trust'

const QR_KEY = 'qr-session-until' // localStorage: este aparelho entrou por QR, válido até (ms)

export function qrSessionUntil(): number { try { return Number(localStorage.getItem(QR_KEY) ?? 0) } catch { return 0 } }
export function setQrSession(until: number | null) {
  try { if (until) localStorage.setItem(QR_KEY, String(until)); else localStorage.removeItem(QR_KEY) } catch { /* storage blocked */ }
}

/**
 * Chama a função; um erro vira o código que ela devolveu. Sem código próprio: 404 = função não
 * publicada, 401 = publicada com "Enforce JWT verification" ligado.
 */
async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('qr-login', { body })
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

export interface QrStart { id: string; pairCode: string; pollSecret: string; matchCode: number; expiresAt: string }
export type QrPoll = { status: 'pending' | 'denied' | 'expired' | 'used' } | { status: 'approved'; tokenHash: string }
export interface QrInfo { requester: { os?: string; browser?: string; ip?: string }; createdAt: string; expiresAt: string; choices: number[] }

export const startQr = () => call<QrStart>({ action: 'start', requester: describeAgent(navigator.userAgent) })
export const pollQr = (s: QrStart) => call<QrPoll>({ action: 'poll', id: s.id, pollSecret: s.pollSecret })
export const qrInfo = (pairCode: string) => call<QrInfo>({ action: 'info', pairCode })
export const approveQr = (pairCode: string, match: number) => call<{ status: string }>({ action: 'approve', pairCode, match })
export const denyQr = (pairCode: string) => call<{ status: string }>({ action: 'approve', pairCode, deny: true })

/** Aprovado: entra com o token de uso único e registra a sessão como aprovada (acesso pontual). */
export async function completeQr(s: QrStart, tokenHash: string): Promise<void> {
  const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' })
  if (error) throw new Error(error.message)
  const { expiresAt } = await call<{ expiresAt: string }>({ action: 'bind', id: s.id, pollSecret: s.pollSecret })
  setQrSession(Date.parse(expiresAt))
  noteSignedIn(false) // nunca "salvar este aparelho": só esta aba, até fechar ou expirar
}

/** O servidor ainda aceita esta sessão (não expirou nem foi revogada)? */
export async function qrSessionValid(): Promise<boolean> {
  const { data, error } = await supabase.rpc('strong_session')
  return !error && data === true
}

export interface ApprovedSession { session_id: string; requester: { os?: string; browser?: string; ip?: string }; approved_at: string; expires_at: string }
/** Acessos pontuais ativos; null se a migração 010 ainda não rodou. */
export async function activeApprovals(): Promise<ApprovedSession[] | null> {
  const r = await supabase.from('approved_sessions').select('session_id, requester, approved_at, expires_at')
    .is('revoked_at', null).gt('expires_at', new Date().toISOString()).order('approved_at', { ascending: false })
  return r.error ? null : (r.data as ApprovedSession[])
}
export async function revokeApproval(sessionId: string): Promise<void> {
  const r = await supabase.from('approved_sessions').update({ revoked_at: new Date().toISOString() }).eq('session_id', sessionId)
  if (r.error) throw new Error(r.error.message)
}
