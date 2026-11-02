// Biometria (WebAuthn / passkey) como segundo fator, no lugar do código de 6 dígitos: a chave fica no
// chip de segurança do aparelho e é destravada com Face ID, Touch ID ou digital. Cada aparelho cadastra
// a sua, com o nome do aparelho; o código do autenticador continua valendo como reserva.
// Exige WebAuthn ligado no projeto Supabase (Authentication → Sign In / Providers).
import type { Factor } from '@supabase/supabase-js'
import { supabase } from './supabase'

const FACTOR_KEY = 'webauthn-factor' // this device's factor, so the login offers it first

export const biometricSupported = () => typeof window !== 'undefined' && 'PublicKeyCredential' in window

/** The verified biometric factors of the account (one per device that registered one). */
export async function biometricFactors(): Promise<Factor[]> {
  const { data } = await supabase.auth.mfa.listFactors()
  return (data?.all ?? []).filter((f) => f.factor_type === 'webauthn' && f.status === 'verified')
}

export function thisDeviceFactor(): string | null { try { return localStorage.getItem(FACTOR_KEY) } catch { return null } }
function keep(id: string | null) { try { if (id) localStorage.setItem(FACTOR_KEY, id); else localStorage.removeItem(FACTOR_KEY) } catch { /* storage blocked */ } }

/** The OS prompt was dismissed or timed out: not an error worth a red message. */
const cancelled = (m: string) => /NotAllowed|abort|cancel|timed out/i.test(m)

/** Registers this device's biometrics (needs the session already at aal2). */
export async function registerBiometric(deviceName: string): Promise<void> {
  // The name must be unique among the account's factors: a device registering again gets the date.
  const taken = new Set((await biometricFactors()).map((f) => f.friendly_name))
  const name = taken.has(deviceName) ? `${deviceName} (${new Date().toLocaleDateString('pt-BR')})` : deviceName
  const { error } = await supabase.auth.mfa.webauthn.register({ friendlyName: name })
  if (error) throw new Error(cancelled(error.message) ? 'Cadastro cancelado.' : error.message)
  keep((await biometricFactors()).find((f) => f.friendly_name === name)?.id ?? null)
}

/** Second factor by biometrics; true when the session is now at aal2. */
export async function authenticateBiometric(factorId: string): Promise<boolean> {
  const { error } = await supabase.auth.mfa.webauthn.authenticate({ factorId })
  if (error) {
    if (cancelled(error.message)) return false
    throw new Error(error.message)
  }
  keep(factorId)
  return true
}

export async function removeBiometric(factorId: string): Promise<void> {
  const { error } = await supabase.auth.mfa.unenroll({ factorId })
  if (error) throw new Error(error.message)
  if (thisDeviceFactor() === factorId) keep(null)
}

/** This device's factor first, when it is still registered; the others after it. */
export function orderForThisDevice(factors: Factor[]): Factor[] {
  const mine = thisDeviceFactor()
  return [...factors].sort((a, b) => Number(b.id === mine) - Number(a.id === mine))
}
