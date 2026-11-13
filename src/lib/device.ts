import { supabase } from './supabase'
import { DEFAULT_OLLAMA, listModels, loadOllama, saveOllama, type OllamaConfig } from './ollama'
import { guessName, matchDevice, normalizeGpu, signoutReason, trustAction, unclaimedDevice, uniqueName, type Device, type Hardware } from '../domain/device'
import { clearPending, keepStorage, pendingSignin, pendingTrust, setTrust, signOutWith, trustedDevice } from './trust'

/**
 * This computer's row in `devices`, found without asking (domain/device.ts decides how),
 * and its Ollama settings copied to localStorage, where every screen reads them.
 * Until migration 006 is run the table does not exist, and the app keeps using the
 * localStorage copy alone, as before.
 */

const ID_KEY = 'device-id'
export const DEVICE_EVENT = 'device-change'

export interface DeviceState {
  device: Device
  devices: Device[]
  /** How it was found, shown in Ajustes so a wrong guess is easy to spot. */
  how: 'lembrado' | 'reconhecido' | 'novo' | 'escolhido'
}

let state: DeviceState | null = null
export const deviceState = () => state

function publish(next: DeviceState) {
  state = next
  try { localStorage.setItem(ID_KEY, next.device.id) } catch { /* storage blocked: identified again next visit */ }
  saveOllama(configOf(next.device))
  window.dispatchEvent(new Event(DEVICE_EVENT))
}

export const configOf = (d: Device): OllamaConfig => ({ url: d.ollama_url || DEFAULT_OLLAMA.url, model: d.ollama_model, enabled: d.ollama_enabled })

/** What the browser can see of the hardware. WebGL's renderer string is the distinctive part. */
export function readHardware(): Hardware {
  const nav = navigator as Navigator & { deviceMemory?: number; userAgentData?: { platform?: string } }
  let gpu: string | undefined
  try {
    const gl = document.createElement('canvas').getContext('webgl')
    const ext = gl?.getExtension('WEBGL_debug_renderer_info')
    gpu = normalizeGpu(gl && ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string : gl?.getParameter(gl.RENDERER) as string)
  } catch { /* no WebGL: the models still identify the machine */ }
  const ua = navigator.userAgent
  const os = nav.userAgentData?.platform
    || (/Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : undefined)
  return { os, cores: navigator.hardwareConcurrency || undefined, memory: nav.deviceMemory, gpu }
}

const mobile = () => /Android|iPhone|iPad/.test(navigator.userAgent)

/**
 * Digests of the models in the Ollama on this machine. Skipped on phones: there is no
 * Ollama there, and Chrome would ask for local-network permission for nothing.
 */
async function localDigests(url: string): Promise<string[]> {
  if (mobile()) return []
  try {
    return (await listModels({ url }, 2500)).map((m) => m.digest).filter((d): d is string => Boolean(d))
  } catch { return [] }
}

async function listDevices(): Promise<Device[] | null> {
  const r = await supabase.from('devices').select('*').order('name')
  if (r.error) return null // table not created yet (migration 006)
  return r.data as Device[]
}

async function updateDevice(id: string, patch: Partial<Omit<Device, 'id'>>): Promise<Device> {
  const r = await supabase.from('devices').update(patch).eq('id', id).select().single()
  if (r.error) throw new Error(r.error.message)
  return r.data as Device
}

const TRUST_FIELDS = ['trusted_until', 'revoked_at', 'kind', 'last_signout', 'last_signin_at'] as const
/** Before migration 008 those columns do not exist: the rest is saved, the trust stays in the browser. */
async function updateWithTrust(id: string, patch: Partial<Omit<Device, 'id'>>): Promise<Device> {
  try { return await updateDevice(id, patch) } catch (e) {
    if (!TRUST_FIELDS.some((f) => (e as Error).message.includes(f))) throw e
    return updateDevice(id, Object.fromEntries(Object.entries(patch).filter(([k]) => !(TRUST_FIELDS as readonly string[]).includes(k))))
  }
}

const DAY = 86400000
/**
 * This device's trust, applied on every load: renewed while in use, dropped when revoked from
 * another device (then the app signs out), and the reason of the last sign-in written down.
 */
function trustPatch(device: Device, how: DeviceState['how']): { patch: Partial<Device>; revoked: boolean } {
  const now = new Date()
  const action = trustAction({ localTrusted: trustedDevice(), pending: pendingTrust(), revokedAt: device.revoked_at })
  const patch: Partial<Device> = { kind: mobile() ? 'celular' : 'computador' }
  if (action === 'renew') { setTrust(true); patch.trusted_until = new Date(now.getTime() + 30 * DAY).toISOString(); patch.revoked_at = null }
  if (action === 'forget') patch.trusted_until = null
  const signin = pendingSignin()
  if (signin !== null) { patch.last_signout = signoutReason(signin || null, how); patch.last_signin_at = now.toISOString() }
  return { patch, revoked: action === 'revoked' }
}

let running: Promise<DeviceState | null> | null = null

/**
 * Runs on app load (and from Ajustes if that failed). Never throws: the AI is optional and
 * must not block the app. Concurrent calls share one run, so a new machine is created once.
 */
export function syncDevice(): Promise<DeviceState | null> {
  running ??= identify().finally(() => { running = null })
  return running
}

async function identify(): Promise<DeviceState | null> {
  try {
    const devices = await listDevices()
    if (!devices) return null
    let storedId: string | null = null
    try { storedId = localStorage.getItem(ID_KEY) } catch { /* storage blocked */ }
    const hardware = readHardware()
    const local = loadOllama()

    // The cheap evidence first; the local Ollama is only asked when the hardware is not enough.
    let device = matchDevice(devices, { storedId, hardware, digests: [] })
    let how: DeviceState['how'] = device && device.id === storedId ? 'lembrado' : 'reconhecido'
    const digests = await localDigests(device?.ollama_url || local.url)
    if (!device) device = matchDevice(devices, { hardware, digests })
    // A phone is never the computer an entry was written for.
    if (!device && !mobile()) device = unclaimedDevice(devices)

    const seen = { hardware, last_seen_at: new Date().toISOString(), ...(digests.length ? { model_digests: digests } : {}) }
    if (device) {
      const trust = trustPatch(device, how)
      if (trust.revoked) { setTrust(false); clearPending(); await signOutWith('revogado'); return null }
      device = await updateWithTrust(device.id, { ...seen, ...trust.patch })
    } else {
      // A machine never seen: create it, carrying over what this browser had configured.
      how = 'novo'
      const r = await supabase.from('devices').insert({
        name: uniqueName(guessName(hardware), devices.map((d) => d.name)),
        ...seen, ollama_url: local.url, ollama_model: local.model, ollama_enabled: local.enabled,
      }).select().single()
      if (r.error) throw new Error(r.error.message)
      device = await updateWithTrust((r.data as Device).id, trustPatch(r.data as Device, how).patch)
    }
    clearPending()
    if (trustedDevice()) void keepStorage()
    publish({ device, devices: [...devices.filter((d) => d.id !== device.id), device].sort((a, b) => a.name.localeCompare(b.name)), how })
    return state
  } catch (e) {
    console.warn('Não foi possível identificar este computador:', e)
    return null
  }
}

/** Saves this computer's Ollama settings (and/or name) to its row. */
export async function saveThisDevice(patch: Partial<Pick<Device, 'name' | 'ollama_url' | 'ollama_model' | 'ollama_enabled'>>) {
  if (!state) return
  const device = await updateDevice(state.device.id, patch)
  publish({ ...state, device, devices: state.devices.map((d) => (d.id === device.id ? device : d)) })
}

/** "This is actually that computer": the user corrects a wrong or new identification. */
export async function chooseDevice(id: string) {
  if (!state) return
  const device = await updateDevice(id, { hardware: readHardware(), last_seen_at: new Date().toISOString() })
  publish({ device, devices: state.devices.map((d) => (d.id === device.id ? device : d)), how: 'escolhido' })
}

/** Revokes another device: it loses "lembrar" and is signed out the next time it opens the app. */
export async function revokeDevice(id: string) {
  if (!state) return
  const device = await updateDevice(id, { revoked_at: new Date().toISOString(), trusted_until: null })
  publish({ ...state, devices: state.devices.map((d) => (d.id === id ? device : d)) })
}

/** Ends every other session at once on the server, and revokes the other devices. */
export async function signOutOthers() {
  if (!state) return
  const r = await supabase.auth.signOut({ scope: 'others' })
  if (r.error) throw new Error(r.error.message)
  for (const d of state.devices) if (d.id !== state.device.id && d.trusted_until) await revokeDevice(d.id)
  // Acessos pontuais por QR code: sem isso, o token ainda válido (até 1 h) continuaria lendo os dados.
  await supabase.from('approved_sessions').update({ revoked_at: new Date().toISOString() }).is('revoked_at', null) // sem a migração 010: ignora
}

export async function deleteDevice(id: string) {
  if (!state || id === state.device.id) return
  const r = await supabase.from('devices').delete().eq('id', id)
  if (r.error) throw new Error(r.error.message)
  publish({ ...state, devices: state.devices.filter((d) => d.id !== id) })
}
