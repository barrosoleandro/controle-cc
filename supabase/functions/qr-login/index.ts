// Edge Function "qr-login": acesso pontual de um aparelho novo, aprovado pelo celular já logado.
// Publicar: Supabase → Edge Functions → Deploy a new function → nome "qr-login", colar este arquivo,
// e DESLIGAR "Enforce JWT verification" (a função valida o token ela mesma; "start" e "poll" vêm de
// um aparelho ainda sem login). Pela CLI: supabase functions deploy qr-login --no-verify-jwt
//
// Ações (POST JSON { action, ... }):
//   start   laptop, sem login     → cria o pedido; devolve código de pareamento, número e segredo
//   info    celular, aal2         → o que pediu o acesso e 3 números para escolher
//   approve celular, aal2 + MFA confirmado há < 5 min → aprova (ou nega) o pedido
//   poll    laptop, com o segredo → quando aprovado, um token de login de uso único
//   bind    laptop, já com a sessão nova → registra a sessão como aprovada por 12 horas
//
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já existem em toda Edge Function.

export const PAIR_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ' // sem 0/O, 1/I/L
export const PAIR_LENGTH = 8
export const REQUEST_MS = 2 * 60_000 // o QR vale 2 minutos; depois de aprovado, mais 2 para o laptop entrar
export const SESSION_MS = 12 * 3600_000 // a sessão aprovada vale no máximo 12 horas
export const FRESH_MFA_S = 5 * 60 // a aprovação exige biometria/código confirmados há menos de 5 minutos
const MFA_METHODS = new Set(['totp', 'mfa/totp', 'mfa/webauthn', 'mfa/phone'])
const LOGIN_METHODS = new Set(['magiclink', 'otp'])

/** "k7m2-q9xd", a URL com ?aprovar=…, espaços: só os 8 caracteres válidos, ou null. */
export function normalizePairCode(raw: string): string | null {
  const m = raw.match(/[?&]aprovar=([^&#]+)/)
  const code = (m ? decodeURIComponent(m[1]) : raw).toUpperCase().replace(/[\s-]/g, '')
  if (code.length !== PAIR_LENGTH) return null
  return [...code].every((c) => PAIR_ALPHABET.includes(c)) ? code : null
}

export function randomPairCode(rand: (n: number) => number): string {
  return Array.from({ length: PAIR_LENGTH }, () => PAIR_ALPHABET[rand(PAIR_ALPHABET.length)]).join('')
}

/** O número certo e dois outros, embaralhados: o celular mostra os três. */
export function matchChoices(match: number, rand: (n: number) => number): number[] {
  const set = new Set([match])
  // Sorteados; se o sorteio insistir em repetir, números fixos longe do certo (nunca trava).
  for (let k = 0; set.size < 3; k++) set.add(k < 50 ? 10 + rand(90) : 10 + ((match - 10 + set.size * 31) % 90))
  const out = [...set]
  for (let i = out.length - 1; i > 0; i--) { const j = rand(i + 1); [out[i], out[j]] = [out[j], out[i]] }
  return out
}

type Amr = { method: string; timestamp: number } | string
/** Biometria ou código do autenticador confirmados nesta sessão nos últimos FRESH_MFA_S segundos. */
export function freshMfa(amr: Amr[] | undefined, nowS: number): boolean {
  return (amr ?? []).some((a) => typeof a === 'object' && MFA_METHODS.has(a.method) && nowS - a.timestamp <= FRESH_MFA_S)
}

/** A sessão foi criada pelo token deste pedido (login por link, depois de `sinceS`). */
export function loggedInSince(amr: Amr[] | undefined, sinceS: number): boolean {
  return (amr ?? []).some((a) => typeof a === 'object' && LOGIN_METHODS.has(a.method) && a.timestamp >= sinceS - 5)
}

export function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(part + '='.repeat((4 - (part.length % 4)) % 4)))
  } catch { return null }
}

// ─── Runtime (Deno) ─────────────────────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*', // autenticação por bearer token, sem cookies
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
const fail = (status: number, error: string) => json({ error }, status)

const randInt = (n: number) => { const b = new Uint32Array(1); crypto.getRandomValues(b); return b[0] % n }
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
async function sha256(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('')
}

// deno-lint-ignore no-explicit-any
type Db = any
let admin: Db = null
async function db(): Promise<Db> {
  if (admin) return admin
  const { createClient } = await import('npm:@supabase/supabase-js@2')
  // deno-lint-ignore no-explicit-any
  const env = (globalThis as any).Deno.env
  admin = createClient(env.get('SUPABASE_URL'), env.get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } })
  return admin
}

/** Valida o token no servidor de Auth e devolve as claims (aal, amr, session_id). */
async function caller(req: Request): Promise<Record<string, unknown> | null> {
  const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  const claims = decodeJwt(token)
  if (!claims?.session_id) return null // a chave anon não é uma sessão
  const { data, error } = await (await db()).auth.getUser(token)
  if (error || !data?.user || data.user.id !== claims.sub) return null
  return claims
}

async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return fail(405, 'method')
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return fail(400, 'json') }
  const sb = await db()
  const now = Date.now()
  const nowIso = new Date(now).toISOString()

  switch (body.action) {
    case 'start': {
      const recent = await sb.from('qr_logins').select('id', { count: 'exact', head: true }).gt('created_at', new Date(now - 5 * 60_000).toISOString())
      if ((recent.count ?? 0) >= 30) return fail(429, 'muitos_pedidos')
      await sb.from('qr_logins').delete().lt('created_at', new Date(now - 86400_000).toISOString())
      const r = (body.requester ?? {}) as Record<string, unknown>
      const requester = {
        os: String(r.os ?? '').slice(0, 40), browser: String(r.browser ?? '').slice(0, 40),
        ip: (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim().slice(0, 45),
      }
      const secret = new Uint8Array(32); crypto.getRandomValues(secret)
      const pollSecret = b64url(secret)
      const matchCode = 10 + randInt(90)
      for (let attempt = 0; attempt < 3; attempt++) {
        const pairCode = randomPairCode(randInt)
        const ins = await sb.from('qr_logins').insert({
          pair_code: pairCode, poll_hash: await sha256(pollSecret), match_code: matchCode, requester,
          expires_at: new Date(now + REQUEST_MS).toISOString(),
        }).select('id, expires_at').single()
        if (!ins.error) return json({ id: ins.data.id, pairCode, pollSecret, matchCode, expiresAt: ins.data.expires_at })
        if (ins.error.code !== '23505') return fail(500, 'start')
      }
      return fail(500, 'start')
    }

    case 'info':
    case 'approve': {
      const claims = await caller(req)
      if (!claims || claims.aal !== 'aal2') return fail(401, 'precisa_aal2')
      const code = normalizePairCode(String(body.pairCode ?? ''))
      if (!code) return fail(400, 'codigo_invalido')
      const { data: row } = await sb.from('qr_logins').select('*').eq('pair_code', code).maybeSingle()
      if (!row || row.status !== 'pending' || Date.parse(row.expires_at) < now) return fail(404, 'pedido_expirado')
      if (body.action === 'info') return json({ requester: row.requester, createdAt: row.created_at, expiresAt: row.expires_at, choices: matchChoices(row.match_code, randInt) })

      if (body.deny === true || Number(body.match) !== row.match_code) {
        await sb.from('qr_logins').update({ status: 'denied' }).eq('id', row.id).eq('status', 'pending')
        return body.deny === true ? json({ status: 'denied' }) : fail(409, 'numero_errado')
      }
      if (!freshMfa(claims.amr as Amr[], Math.floor(now / 1000))) return fail(401, 'confirme_biometria')
      const upd = await sb.from('qr_logins').update({
        status: 'approved', user_id: claims.sub, approved_at: nowIso, expires_at: new Date(now + REQUEST_MS).toISOString(),
      }).eq('id', row.id).eq('status', 'pending').select('id').maybeSingle()
      if (!upd.data) return fail(409, 'pedido_expirado')
      return json({ status: 'approved' })
    }

    case 'poll': {
      const { data: row } = await sb.from('qr_logins').select('*')
        .eq('id', String(body.id ?? '')).eq('poll_hash', await sha256(String(body.pollSecret ?? ''))).maybeSingle()
      if (!row) return fail(404, 'pedido')
      if (row.status === 'denied') return json({ status: 'denied' })
      if (row.status === 'claimed' || row.status === 'done') return json({ status: 'used' })
      if (Date.parse(row.expires_at) < now) return json({ status: 'expired' })
      if (row.status === 'pending') return json({ status: 'pending' })
      // Aprovado: um token de login de uso único (nenhum e-mail é enviado).
      const claim = await sb.from('qr_logins').update({ status: 'claimed', claimed_at: nowIso })
        .eq('id', row.id).eq('status', 'approved').select('id').maybeSingle()
      if (!claim.data) return json({ status: 'used' })
      const { data: u } = await sb.auth.admin.getUserById(row.user_id)
      if (!u?.user?.email) return fail(500, 'usuario')
      const link = await sb.auth.admin.generateLink({ type: 'magiclink', email: u.user.email })
      if (link.error) return fail(500, 'link')
      return json({ status: 'approved', tokenHash: link.data.properties.hashed_token })
    }

    case 'bind': {
      const claims = await caller(req)
      if (!claims) return fail(401, 'sessao')
      const { data: row } = await sb.from('qr_logins').select('*')
        .eq('id', String(body.id ?? '')).eq('poll_hash', await sha256(String(body.pollSecret ?? ''))).maybeSingle()
      if (!row || row.status !== 'claimed' || row.user_id !== claims.sub) return fail(404, 'pedido')
      const claimedS = Math.floor(Date.parse(row.claimed_at) / 1000)
      if (now - Date.parse(row.claimed_at) > REQUEST_MS || !loggedInSince(claims.amr as Amr[], claimedS)) return fail(409, 'pedido_expirado')
      const expiresAt = new Date(now + SESSION_MS).toISOString()
      const ins = await sb.from('approved_sessions').insert({
        session_id: claims.session_id, user_id: claims.sub, qr_login_id: row.id, requester: row.requester, expires_at: expiresAt,
      })
      if (ins.error) return fail(500, 'bind')
      await sb.from('qr_logins').update({ status: 'done' }).eq('id', row.id)
      return json({ expiresAt })
    }
  }
  return fail(400, 'action')
}

// deno-lint-ignore no-explicit-any
const deno = (globalThis as any).Deno
if (deno?.serve) deno.serve((req: Request) => handler(req).catch((e) => { console.error(e); return fail(500, 'erro') }))
