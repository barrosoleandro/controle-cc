/**
 * Which computer is this? A web page cannot read the machine's name, so a device is
 * recognised by what the browser can see of it — the hardware — and by the models its
 * local Ollama holds. Both are compared as evidence, never as an exact key: a second
 * monitor, another browser or a newly pulled model must not turn a known machine into a
 * stranger.
 */

/** What the browser reports about the machine. Every field is optional: browsers differ. */
export interface Hardware {
  os?: string
  /** Logical processors (navigator.hardwareConcurrency). */
  cores?: number
  /** GB, bucketed by the browser (navigator.deviceMemory). Chrome/Edge only. */
  memory?: number
  /** GPU as WebGL names it, normalised (see normalizeGpu). The most distinctive field. */
  gpu?: string
}

export interface Device {
  id: string
  name: string
  hardware: Hardware
  /** Digests of the models in this machine's Ollama, as /api/tags lists them. */
  model_digests: string[]
  ollama_url: string
  ollama_model: string
  ollama_enabled: boolean
  last_seen_at: string | null
  // Migration 008 (absent before it is run)
  trusted_until?: string | null
  revoked_at?: string | null
  kind?: string | null
  last_signout?: string | null
  last_signin_at?: string | null
}

/** Why a device had to sign in again, as recorded by the app (lib/trust.ts). */
export const SIGNOUT_REASON = {
  manual: 'você saiu pelo botão',
  inatividade: 'inatividade num aparelho não lembrado',
  expirou: 'mais de 30 dias sem abrir o app neste aparelho',
  revogado: 'aparelho revogado em Ajustes → Aparelhos',
  servidor: 'sessão encerrada pelo servidor (renovação recusada)',
  apagado: 'dados do navegador apagados (ex.: Safari depois de 7 dias sem abrir o site, fora da Tela de Início)',
  primeiro: 'primeiro acesso neste aparelho',
  pontual: 'acesso pontual: aparelho não salvo pede login a cada abertura do app',
} as const
export type SignoutReason = keyof typeof SIGNOUT_REASON

/**
 * What to do with this device's trust on load: renew it (each use pushes the 30 days forward,
 * so a device in use never expires), honour a revocation made from another device, or nothing.
 * `pending`: the user just confirmed the authenticator code, with "lembrar" on or off.
 */
export function trustAction(o: { localTrusted: boolean; pending: 'on' | 'off' | null; revokedAt?: string | null }): 'renew' | 'forget' | 'revoked' | 'none' {
  if (o.pending === 'on') return 'renew' // a fresh code clears an old revocation
  if (o.pending === 'off') return 'forget'
  if (!o.localTrusted) return 'none'
  return o.revokedAt ? 'revoked' : 'renew'
}

/**
 * On opening the app with a session already at aal2, whether it must sign in again:
 * 'expirou' when a saved device went 30 days unused, 'pontual' when the device was not saved
 * and this tab did not sign in itself (the app or browser was closed and opened again).
 */
export function reauthNeeded(o: { trustUntil: number; now: number; tabSignedIn: boolean }): 'expirou' | 'pontual' | null {
  if (o.trustUntil > o.now) return null
  if (o.trustUntil) return 'expirou'
  return o.tabSignedIn ? null : 'pontual'
}

/** Why the last sign-in was needed: the app's own record, else what identifying the device tells. */
export function signoutReason(recorded: string | null, how: 'lembrado' | 'reconhecido' | 'novo' | 'escolhido'): SignoutReason {
  if (recorded && recorded in SIGNOUT_REASON) return recorded as SignoutReason
  if (how === 'novo') return 'primeiro'
  // Recognized by its hardware, not by the id this browser kept: the browser's data was wiped.
  if (how === 'reconhecido' || how === 'escolhido') return 'apagado'
  return 'servidor'
}

export interface Seen {
  /** Device id this browser remembered from a previous visit. */
  storedId?: string | null
  hardware: Hardware
  /** Digests the local Ollama answered with; empty when it was not reached. */
  digests: string[]
}

/**
 * Chrome says "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)".
 * The PCI id and the graphics API vary with the browser and driver, the card does not.
 */
export function normalizeGpu(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined
  const s = raw
    .replace(/^ANGLE\s*\(/i, '')
    .replace(/\(0x[0-9a-f]+\)/gi, '')
    .replace(/\s*,?\s*(Direct3D|D3D\d|OpenGL|Vulkan|Metal).*$/i, '')
    .replace(/\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s,]+$/, '')
    .trim()
  return s || undefined
}

/** Shared models / all models. Model digests are content hashes, so equal models on two machines match. */
function overlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0
  const sa = new Set(a), sb = new Set(b)
  let both = 0
  for (const d of sa) if (sb.has(d)) both++
  return both / new Set([...sa, ...sb]).size
}

/**
 * How strongly what this browser sees points at a stored device, or null when it cannot be
 * that device. A different OS rules it out; anything else only adds or withholds points,
 * because Firefox and Safari report less (or blur) what Chrome reports in full.
 */
export function deviceScore(d: Device, seen: Seen): number | null {
  const h = d.hardware ?? {}, s = seen.hardware
  if (h.os && s.os && h.os !== s.os) return null
  const gpu = Boolean(h.gpu && s.gpu && h.gpu === s.gpu)
  const models = overlap(d.model_digests ?? [], seen.digests)
  // Without the card or the model list in common, cores and memory alone fit too many machines.
  if (!gpu && models < 0.5) return null
  return (gpu ? 4 : 0) + models * 4
    + (h.cores && h.cores === s.cores ? 1 : 0)
    + (h.memory && h.memory === s.memory ? 1 : 0)
}

/**
 * The stored device this browser is on, or null when none fits or two fit equally — a
 * tie is a question for the user, not something to guess.
 */
export function matchDevice(devices: Device[], seen: Seen): Device | null {
  if (seen.storedId) {
    const known = devices.find((d) => d.id === seen.storedId)
    if (known) return known
  }
  const scored = devices
    .map((d) => ({ d, score: deviceScore(d, seen) }))
    .filter((x): x is { d: Device; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score)
  if (!scored.length) return null
  if (scored.length > 1 && scored[0].score === scored[1].score) return null
  return scored[0].d
}

/**
 * A machine entry written ahead of time (supabase/seeds) that no browser has reported
 * hardware for yet. When it is the only one, the first computer that cannot be recognised
 * otherwise is taken to be it — the model check can miss on that first visit (Chrome is
 * still asking for local-network permission) and a duplicate entry would be created.
 */
export function unclaimedDevice(devices: Device[]): Device | null {
  const waiting = devices.filter((d) => !Object.keys(d.hardware ?? {}).length)
  return waiting.length === 1 ? waiting[0] : null
}

/** A first name for a machine the browser cannot name: "Windows · Intel Iris Xe Graphics". */
export function guessName(h: Hardware): string {
  const gpu = h.gpu?.replace(/\((R|TM)\)/gi, '').replace(/^[^,]+,\s*/, '').replace(/\s+/g, ' ').trim()
  const what = gpu || (h.cores ? `${h.cores} núcleos` : '')
  return [h.os || 'Computador', what].filter(Boolean).join(' · ')
}

/** Names are unique per user; a second identical machine becomes "… (2)". */
export function uniqueName(name: string, taken: string[]): string {
  const used = new Set(taken.map((t) => t.toLowerCase()))
  if (!used.has(name.toLowerCase())) return name
  for (let i = 2; ; i++) if (!used.has(`${name} (${i})`.toLowerCase())) return `${name} (${i})`
}
