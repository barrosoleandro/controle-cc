// Edge Function "household-access": uma pessoa entra no app sem senha nem e-mail, aprovada pelo
// celular do dono da casa (QR code + número de conferência). Precisa das migrações 011 e 012.
//
// Publicar: Supabase → Edge Functions → Deploy a new function → nome "household-access", colar este
// arquivo e DESLIGAR "Enforce JWT verification" ("start" e "poll" vêm de um aparelho ainda sem login;
// a função valida o token ela mesma). Pela CLI: supabase functions deploy household-access --no-verify-jwt
//
// Ações (POST JSON { action, ... }):
//   start   aparelho novo, sem login   → cria o pedido (e-mail da pessoa); devolve código, número e segredo
//   info    dono da casa, logado       → quem pediu e 3 números para escolher
//   approve dono da casa, logado       → aprova (cria a conta e inclui na casa, se for nova) ou nega
//   poll    aparelho novo, com segredo → quando aprovado, um token de login de uso único
//   remove  dono da casa, logado       → apaga a conta de um membro (os dados da casa ficam)
//
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já existem em toda Edge Function.

export const PAIR_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ' // sem 0/O, 1/I/L
export const PAIR_LENGTH = 8
export const REQUEST_MS = 2 * 60_000 // o QR vale 2 minutos; depois de aprovado, mais 2 para o aparelho entrar

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

export function normalizeEmail(raw: unknown): string | null {
  const e = String(raw ?? '').trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254 ? e : null
}

/**
 * O que a aprovação faz com a conta pedida.
 * approverOwner: o dono da casa de quem aprova, se quem aprova for membro (membro não aprova).
 * target: a conta com o e-mail pedido (null se não existe) e o dono da casa dela, se for membro.
 */
export function approvalPlan(o: { approverId: string; approverOwner: string | null; target: { id: string; owner: string | null } | null }):
  'create' | 'login' | 'so_dono' | 'conta_de_outra_casa' {
  if (o.approverOwner) return 'so_dono'
  if (!o.target) return 'create'
  if (o.target.id === o.approverId || o.target.owner === o.approverId) return 'login'
  return 'conta_de_outra_casa'
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

/** Quem chama, validado no servidor de Auth (a chave anon não é uma sessão). */
async function caller(req: Request): Promise<string | null> {
  const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  const claims = decodeJwt(token)
  if (!claims?.session_id) return null
  const { data, error } = await (await db()).auth.getUser(token)
  if (error || !data?.user || data.user.id !== claims.sub) return null
  return data.user.id
}

async function ownerOf(sb: Db, userId: string): Promise<string | null> {
  const { data } = await sb.from('household_members').select('owner_id').eq('member_id', userId).maybeSingle()
  return data?.owner_id ?? null
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
      const email = normalizeEmail(body.email)
      if (!email) return fail(400, 'email_invalido')
      const recent = await sb.from('access_requests').select('id', { count: 'exact', head: true }).gt('created_at', new Date(now - 5 * 60_000).toISOString())
      if ((recent.count ?? 0) >= 30) return fail(429, 'muitos_pedidos')
      await sb.from('access_requests').delete().lt('created_at', new Date(now - 86400_000).toISOString())
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
        const ins = await sb.from('access_requests').insert({
          pair_code: pairCode, poll_hash: await sha256(pollSecret), match_code: matchCode, email, requester,
          expires_at: new Date(now + REQUEST_MS).toISOString(),
        }).select('id, expires_at').single()
        if (!ins.error) return json({ id: ins.data.id, pairCode, pollSecret, matchCode, expiresAt: ins.data.expires_at })
        if (ins.error.code !== '23505') return fail(500, 'start')
      }
      return fail(500, 'start')
    }

    case 'info':
    case 'approve': {
      const approver = await caller(req)
      if (!approver) return fail(401, 'precisa_login')
      const code = normalizePairCode(String(body.pairCode ?? ''))
      if (!code) return fail(400, 'codigo_invalido')
      const { data: row } = await sb.from('access_requests').select('*').eq('pair_code', code).maybeSingle()
      if (!row || row.status !== 'pending' || Date.parse(row.expires_at) < now) return fail(404, 'pedido_expirado')

      const targetId: string | null = (await sb.rpc('user_id_by_email', { p_email: row.email })).data ?? null
      const plan = approvalPlan({
        approverId: approver, approverOwner: await ownerOf(sb, approver),
        target: targetId ? { id: targetId, owner: await ownerOf(sb, targetId) } : null,
      })
      if (body.action === 'info') {
        return json({ email: row.email, requester: row.requester, createdAt: row.created_at, plan, choices: matchChoices(row.match_code, randInt) })
      }

      if (body.deny === true || Number(body.match) !== row.match_code) {
        await sb.from('access_requests').update({ status: 'denied' }).eq('id', row.id).eq('status', 'pending')
        return body.deny === true ? json({ status: 'denied' }) : fail(409, 'numero_errado')
      }
      if (plan === 'so_dono' || plan === 'conta_de_outra_casa') return fail(403, plan)
      // Reserva o pedido antes de criar a conta: dois toques em "Aprovar" não criam duas.
      const lock = await sb.from('access_requests').update({ status: 'approved', approved_by: approver, approved_at: nowIso, expires_at: new Date(now + REQUEST_MS).toISOString() })
        .eq('id', row.id).eq('status', 'pending').select('id').maybeSingle()
      if (!lock.data) return fail(409, 'pedido_expirado')

      let userId = targetId
      if (plan === 'create') {
        // Conta nova já na casa, antes do primeiro login (o app não cria categorias e contas padrão).
        const created = await sb.auth.admin.createUser({ email: row.email, email_confirm: true })
        if (created.error || !created.data?.user) { await sb.from('access_requests').update({ status: 'denied' }).eq('id', row.id); return fail(500, 'criar_conta') }
        userId = created.data.user.id
        const link = await sb.from('household_members').insert({ member_id: userId, owner_id: approver, email: row.email })
        if (link.error) { await sb.auth.admin.deleteUser(userId); await sb.from('access_requests').update({ status: 'denied' }).eq('id', row.id); return fail(500, 'incluir_na_casa') }
      }
      await sb.from('access_requests').update({ user_id: userId }).eq('id', row.id)
      return json({ status: 'approved', created: plan === 'create' })
    }

    case 'poll': {
      const { data: row } = await sb.from('access_requests').select('*')
        .eq('id', String(body.id ?? '')).eq('poll_hash', await sha256(String(body.pollSecret ?? ''))).maybeSingle()
      if (!row) return fail(404, 'pedido')
      if (row.status === 'denied') return json({ status: 'denied' })
      if (row.status === 'claimed') return json({ status: 'used' })
      if (Date.parse(row.expires_at) < now) return json({ status: 'expired' })
      if (row.status === 'pending' || !row.user_id) return json({ status: 'pending' })
      const claim = await sb.from('access_requests').update({ status: 'claimed', claimed_at: nowIso })
        .eq('id', row.id).eq('status', 'approved').select('id').maybeSingle()
      if (!claim.data) return json({ status: 'used' })
      const link = await sb.auth.admin.generateLink({ type: 'magiclink', email: row.email })
      if (link.error) return fail(500, 'link')
      return json({ status: 'approved', tokenHash: link.data.properties.hashed_token })
    }

    case 'remove': {
      const owner = await caller(req)
      if (!owner) return fail(401, 'precisa_login')
      const memberId = String(body.memberId ?? '')
      const { data: m } = await sb.from('household_members').select('member_id').eq('member_id', memberId).eq('owner_id', owner).maybeSingle()
      if (!m) return fail(404, 'membro')
      // Apaga a conta: encerra o acesso de vez. As linhas da casa estão no nome do dono e ficam.
      const del = await sb.auth.admin.deleteUser(memberId)
      if (del.error) return fail(500, 'remover')
      return json({ status: 'removed' })
    }
  }
  return fail(400, 'action')
}

// deno-lint-ignore no-explicit-any
const deno = (globalThis as any).Deno
if (deno?.serve) deno.serve((req: Request) => handler(req).catch((e) => { console.error(e); return fail(500, 'erro') }))
