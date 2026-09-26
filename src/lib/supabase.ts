import { createClient } from '@supabase/supabase-js'

const url = import.meta.env?.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env?.VITE_SUPABASE_ANON_KEY as string | undefined
export const configured = Boolean(url && anonKey)

/** Which env vars are missing, so the UI can say so instead of rendering a blank page. */
export const configError = configured
  ? null
  : `Missing build-time environment ${[!url && 'VITE_SUPABASE_URL', !anonKey && 'VITE_SUPABASE_ANON_KEY'].filter(Boolean).join(' and ')}.`

// Only the public anon key is ever used in the browser; data is protected by RLS + MFA.
export const supabase = createClient(url ?? 'http://localhost', anonKey ?? 'missing', {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'controlecc-auth' },
})
