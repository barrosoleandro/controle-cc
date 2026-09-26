import { createClient } from '@supabase/supabase-js'

const url = import.meta.env?.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env?.VITE_SUPABASE_ANON_KEY as string | undefined
export const configured = Boolean(url && anonKey)

/** Which env vars are missing, so the UI can say so instead of rendering a blank page. */
export const configError = configured
  ? null
  : `Missing build-time environment ${[!url && 'VITE_SUPABASE_URL', !anonKey && 'VITE_SUPABASE_ANON_KEY'].filter(Boolean).join(' and ')}.`

/**
 * Right after a login or token refresh, the database API can briefly reject the new token
 * with "JWT issued at future" (its clock trails the auth server's by a second or two).
 * Wait and resend instead of surfacing the error; bodies are strings, so resending is safe.
 */
export async function fetchWithSkewRetry(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(input, init)
    if (res.status !== 401 || attempt >= 3) return res
    const body = await res.clone().text()
    if (!body.includes('JWT issued at future')) return res
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
  }
}

// Only the public anon key is ever used in the browser; data is protected by RLS + MFA.
export const supabase = createClient(url ?? 'http://localhost', anonKey ?? 'missing', {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'controlecc-auth' },
  global: { fetch: fetchWithSkewRetry },
})
