// "Lembrar neste dispositivo": a sessão fica de pé sem trava por inatividade; só não se pede
// o login de novo. Os 30 dias andam a cada uso (lib/device.ts
// renova ao abrir o app), então um aparelho em uso não expira; o aparelho também fica registrado no
// servidor (migração 008), de onde pode ser revogado.
import { supabase } from './supabase'
import type { SignoutReason } from '../domain/device'

const TRUST_KEY = 'trustedUntil'
const TRUST_MS = 30 * 86400000
const REASON_KEY = 'signout-reason' // why the app signed out, read on the next sign-in
const PENDING_KEY = 'trust-pending' // the authenticator code was just confirmed: 'on' | 'off'
const SIGNIN_KEY = 'signin-reason' // why this sign-in was needed, until written to the device row

const get = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const put = (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v) } catch { /* storage blocked */ } }

export function trustUntil(): number { return Number(get(TRUST_KEY) ?? 0) }
export const trustedDevice = () => trustUntil() > Date.now()
export function setTrust(on: boolean) { put(TRUST_KEY, on ? String(Date.now() + TRUST_MS) : null) }

/** Every sign-out the app makes says why, so the next sign-in can be explained. */
export function signOutWith(reason: SignoutReason) {
  put(REASON_KEY, reason)
  return supabase.auth.signOut()
}
/** A sign-out the app did not make (the server refused to renew the session). */
export function noteSignedOut() { if (!get(REASON_KEY)) put(REASON_KEY, 'servidor') }

/** Right after the authenticator code: remember the choice and why this sign-in was needed. */
export function noteSignedIn(lembrar: boolean) {
  setTrust(lembrar)
  put(PENDING_KEY, lembrar ? 'on' : 'off')
  put(SIGNIN_KEY, get(REASON_KEY) ?? '')
  put(REASON_KEY, null)
}
/** Read by the device sync, which writes them to the device row and then clears them. */
export const pendingTrust = () => get(PENDING_KEY) as 'on' | 'off' | null
export const pendingSignin = () => get(SIGNIN_KEY)
export function clearPending() { put(PENDING_KEY, null); put(SIGNIN_KEY, null) }

/**
 * Asks the browser not to wipe this site's data (and with it the session) under storage
 * pressure. Chrome grants it to installed apps; Safari only keeps data of apps on the Home Screen.
 */
export async function keepStorage(): Promise<boolean> {
  try { return (await navigator.storage?.persisted?.()) || (await navigator.storage?.persist?.()) || false } catch { return false }
}

/** "Lembrar / esquecer este aparelho" from Ajustes: applied locally now, on the device row at the next sync. */
export function rememberHere(on: boolean) {
  setTrust(on)
  put(PENDING_KEY, on ? 'on' : 'off')
}

/** Installed on the Home Screen / as an app: the only way Safari keeps the login past 7 days unused. */
export const installedApp = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
