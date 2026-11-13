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

// supabase-js registers for a USB security key by default (cross-platform, hints 'security-key',
// no passkey kept on the device). A phone must keep a real passkey, so it can approve a computer by QR.
type CreateOverrides = NonNullable<Parameters<typeof supabase.auth.mfa.webauthn.register>[1]>
type RequestOverrides = NonNullable<Parameters<typeof supabase.auth.mfa.webauthn.authenticate>[1]>
const CREATE: CreateOverrides = {
  hints: ['client-device'],
  authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', requireResidentKey: false, userVerification: 'required' },
}
// 'hybrid' makes the computer's browser go straight to "use a phone" (QR code + Bluetooth).
// The typing asks for a challenge; the server's own challenge is merged in by supabase-js.
const viaPhone = (phone: boolean) => ({ hints: [phone ? 'hybrid' : 'client-device'], userVerification: 'required' }) as Partial<RequestOverrides> as RequestOverrides

/** The OS prompt was dismissed or timed out: not an error worth a red message. */
const cancelled = (m: string) => /NotAllowed|abort|cancel|timed out/i.test(m)

/** Registers this device's biometrics (needs the session already at aal2). */
export async function registerBiometric(deviceName: string): Promise<void> {
  // The name must be unique among the account's factors: a device registering again gets the date.
  const taken = new Set((await biometricFactors()).map((f) => f.friendly_name))
  const name = taken.has(deviceName) ? `${deviceName} (${new Date().toLocaleDateString('pt-BR')})` : deviceName
  const { error } = await supabase.auth.mfa.webauthn.register({ friendlyName: name }, CREATE)
  if (error) throw new Error(cancelled(error.message) ? 'Cadastro cancelado.' : error.message)
  keep((await biometricFactors()).find((f) => f.friendly_name === name)?.id ?? null)
}

/**
 * Second factor by biometrics; true when the session is now at aal2.
 * `phone`: the key is on another device (the phone), reached by the QR code the browser shows.
 */
export async function authenticateBiometric(factorId: string, phone = false): Promise<boolean> {
  const { error } = await supabase.auth.mfa.webauthn.authenticate({ factorId }, viaPhone(phone))
  if (error) {
    if (cancelled(error.message)) return false
    throw new Error(error.message)
  }
  if (!phone) keep(factorId) // a phone's key is not this device's
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
