import { useEffect, useState } from 'react'
import { ask, loadOllama, ollamaReady } from '../lib/ollama'

/**
 * "Explain with the local model" button, shared by every screen that has already
 * computed its numbers. The prompt is built by the caller from those numbers, so the
 * model only ever puts arithmetic into words — it never produces a figure of its own.
 */
export function ExplicarIA({ build, signature, label = 'Explicar com a IA local', note }: {
  /** Called on click; returns the system + user prompt built from facts already on screen. */
  build: () => { system: string; prompt: string }
  /** Changes whenever the underlying numbers change, which clears a stale explanation. */
  signature: string
  label?: string
  note?: string
}) {
  const [cfg, setCfg] = useState(loadOllama)
  const [texto, setTexto] = useState<string | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Turning it on in Ajustes should show up here without a reload.
  useEffect(() => {
    const refresh = () => setCfg(loadOllama())
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])
  // Different numbers: the old text no longer describes them.
  useEffect(() => { setTexto(null); setErro(null) }, [signature])

  async function explicar() {
    const c = loadOllama()
    setCfg(c)
    if (!ollamaReady(c)) { setErro('Ative e configure o endereço e o modelo em Ajustes → IA local.'); return }
    setBusy(true); setErro(null); setTexto(null)
    try {
      const { system, prompt } = build()
      setTexto(await ask(c, prompt, { system, temperature: 0.2 }))
    } catch (e) { setErro((e as Error).message) } finally { setBusy(false) }
  }

  const ready = ollamaReady(cfg)
  return (
    <div style={{ marginTop: 12 }}>
      <div className="row">
        <button onClick={explicar} disabled={busy || !ready}
          title={ready ? 'Roda neste computador; nada é enviado para fora' : 'Configure em Ajustes → IA local'}>
          {busy ? 'Analisando…' : label}
        </button>
        {ready
          ? <span className="muted" style={{ fontSize: 12 }}>{cfg.model} · nada sai deste computador</span>
          : <span className="muted" style={{ fontSize: 12 }}>IA local desligada — ligue em Ajustes → IA local</span>}
      </div>
      {busy && <p className="muted">Um modelo local pode levar alguns minutos.</p>}
      {erro && <p className="err" style={{ whiteSpace: 'pre-wrap' }}>{erro}</p>}
      {texto && (
        <div className="alert" style={{ display: 'block', marginTop: 8 }}>
          <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{texto}</p>
          <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
            {note ?? 'Texto escrito por um modelo local a partir dos números desta tela. Os valores vêm dos seus dados; a leitura é do modelo e pode estar errada — a tabela é a fonte.'}
          </p>
        </div>
      )}
    </div>
  )
}
