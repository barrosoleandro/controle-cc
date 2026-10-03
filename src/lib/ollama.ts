/**
 * Local model through Ollama. Nothing here leaves the machine: the browser talks straight
 * to the Ollama daemon, so merchant names and payslip figures never reach a third party.
 *
 * Kept per device (localStorage), like the appearance setting — the address and the model
 * are properties of the computer in front of you, not of the account, so a laptop running
 * a small model and a desktop running a big one each keep their own.
 *
 * Note on folders: where Ollama stores the model files is a setting of the daemon
 * (the OLLAMA_MODELS environment variable), not something a web page can reach. What
 * changes between computers and does belong here is the address and the model name.
 */

export interface OllamaConfig {
  /** Base URL of the daemon, e.g. http://localhost:11434 or http://192.168.1.50:11434. */
  url: string
  /** Model tag as `ollama list` prints it, e.g. llama3.1:8b. */
  model: string
  /** Off by default: the app only calls a local model once you ask it to. */
  enabled: boolean
}

const KEY = 'ollama'
export const DEFAULT_OLLAMA: OllamaConfig = { url: 'http://localhost:11434', model: '', enabled: false }

/** Trailing slashes and a pasted /api path are the two mistakes worth absorbing silently. */
export function normalizeUrl(raw: string): string {
  const s = raw.trim().replace(/\/+$/, '').replace(/\/api(\/.*)?$/, '')
  if (!s) return ''
  return /^https?:\/\//i.test(s) ? s : `http://${s}`
}

export function loadOllama(): OllamaConfig {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<OllamaConfig>
    return {
      url: normalizeUrl(typeof c.url === 'string' ? c.url : '') || DEFAULT_OLLAMA.url,
      model: typeof c.model === 'string' ? c.model : '',
      enabled: c.enabled === true,
    }
  } catch { return DEFAULT_OLLAMA }
}

export function saveOllama(c: OllamaConfig) {
  try { localStorage.setItem(KEY, JSON.stringify({ ...c, url: normalizeUrl(c.url) })) } catch { /* storage blocked: applies for this visit only */ }
}

/** True when the config is complete enough to call. */
export const ollamaReady = (c: OllamaConfig) => c.enabled && Boolean(c.url) && Boolean(c.model)

export interface OllamaModel { name: string; size: number; family?: string; parameterSize?: string }

const TIMEOUT_LIST = 8000
const TIMEOUT_CHAT = 180000 // a local model on CPU is slow; the user is watching a progress line

async function call(url: string, path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(`${url}${path}`, { ...init, signal: ctrl.signal })
  } catch (e) {
    throw new Error(explainNetworkError(e, url))
  } finally { clearTimeout(timer) }
}

/**
 * fetch gives a bare "Failed to fetch" for every one of: daemon down, CORS refused,
 * CSP blocked, HTTPS page reaching http://. Each has a different fix, so name them.
 */
function explainNetworkError(e: unknown, url: string): string {
  if ((e as Error)?.name === 'AbortError') return `O modelo não respondeu no tempo esperado (${url}).`
  const https = location.protocol === 'https:'
  const localTarget = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(url)
  const hints = [
    `Não foi possível falar com o Ollama em ${url}.`,
    'Confira: o Ollama está rodando (ollama serve)?',
    `Ele aceita chamadas desta página? Defina OLLAMA_ORIGINS=${location.origin} no ambiente do Ollama e reinicie-o.`,
  ]
  if (https && localTarget) {
    hints.push('Esta página está em HTTPS e o Ollama em HTTP local: o Safari bloqueia isso. No Chrome/Edge funciona; se precisar do Safari, use o app rodando local (npm run dev).')
  }
  return hints.join(' ')
}

export async function listModels(cfg: OllamaConfig): Promise<OllamaModel[]> {
  const res = await call(cfg.url, '/api/tags', { method: 'GET' }, TIMEOUT_LIST)
  if (!res.ok) throw new Error(`Ollama respondeu ${res.status} em /api/tags.`)
  const body = await res.json() as { models?: { name: string; size: number; details?: { family?: string; parameter_size?: string } }[] }
  return (body.models ?? []).map((m) => ({
    name: m.name, size: m.size, family: m.details?.family, parameterSize: m.details?.parameter_size,
  })).sort((a, b) => a.name.localeCompare(b.name))
}

export interface AskOptions {
  /** Ask the daemon to emit JSON only. Ollama still sometimes wraps it, so parse defensively. */
  json?: boolean
  system?: string
  /** 0 for classification work: we want the same answer for the same statement line. */
  temperature?: number
  /**
   * Reasoning models (qwen3.5, deepseek-r1…) think before answering, which on a local
   * machine costs minutes for no gain on these tasks. Off unless asked for.
   */
  think?: boolean
  signal?: AbortSignal
}

/**
 * One non-streaming completion. Returns the raw text; callers parse and validate it —
 * a local model is far looser than a hosted one, so nothing it says is trusted as-is.
 */
export async function ask(cfg: OllamaConfig, prompt: string, opts: AskOptions = {}): Promise<string> {
  if (!ollamaReady(cfg)) throw new Error('Configure o endereço e o modelo do Ollama em Ajustes → IA local.')
  const res = await call(cfg.url, '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      stream: false,
      format: opts.json ? 'json' : undefined,
      think: opts.think ?? false,
      options: { temperature: opts.temperature ?? 0 },
      messages: [
        ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
        { role: 'user', content: prompt },
      ],
    }),
  }, TIMEOUT_CHAT)
  if (res.status === 404) throw new Error(`O modelo "${cfg.model}" não existe neste Ollama. Baixe com: ollama pull ${cfg.model}`)
  if (!res.ok) throw new Error(`Ollama respondeu ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = await res.json() as { message?: { content?: string } }
  const text = body.message?.content ?? ''
  if (!text.trim()) throw new Error('O modelo devolveu uma resposta vazia.')
  return text
}
