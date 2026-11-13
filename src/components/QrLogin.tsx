import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import jsQR from 'jsqr'
import { supabase } from '../lib/supabase'
import { approveUrl, formatPairCode, normalizePairCode, qrError } from '../domain/qrLogin'
import { activeApprovals, approveQr, completeQr, denyQr, pollQr, qrInfo, revokeApproval, startQr, type ApprovedSession, type QrInfo, type QrStart } from '../lib/qrLogin'
import { authenticateBiometric, biometricSupported, thisDeviceFactor } from '../lib/biometric'

const POLL_MS = 2000
const msg = (e: unknown) => qrError((e as Error).message)
const quando = (iso: string) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })

/**
 * No aparelho novo (sem login): mostra o QR code e o número de conferência, e espera o celular
 * aprovar. Aprovado, entra como acesso pontual (nunca salva o aparelho).
 */
export function QrRequest({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [req, setReq] = useState<QrStart | null>(null)
  const [img, setImg] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'waiting' | 'entering' | 'ended'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [left, setLeft] = useState(0)
  const [round, setRound] = useState(0) // "Gerar outro"
  const done = useRef(onDone)
  useEffect(() => { done.current = onDone }, [onDone])

  useEffect(() => {
    let alive = true
    setState('loading'); setError(null); setReq(null); setImg(null)
    startQr().then(async (s) => {
      if (!alive) return
      setReq(s); setImg(await QRCode.toDataURL(approveUrl(window.location.origin, s.pairCode), { margin: 1, width: 240 })); setState('waiting')
    }, (e) => { if (alive) { setError(msg(e)); setState('ended') } })
    return () => { alive = false }
  }, [round])

  useEffect(() => {
    if (!req || state !== 'waiting') return
    let busy = false
    const tick = async () => {
      setLeft(Math.max(0, Math.round((Date.parse(req.expiresAt) - Date.now()) / 1000)))
      if (busy) return
      busy = true
      try {
        const r = await pollQr(req)
        if (r.status === 'approved') {
          setState('entering')
          await completeQr(req, r.tokenHash)
          done.current()
        } else if (r.status !== 'pending') {
          setError(r.status === 'denied' ? 'O pedido foi negado no celular (ou o número escolhido estava errado).' : 'O QR code expirou ou já foi usado.')
          setState('ended')
        }
      } catch (e) { setError(msg(e)); setState('ended') } finally { busy = false }
    }
    tick()
    const t = window.setInterval(tick, POLL_MS)
    return () => clearInterval(t)
  }, [req, state])

  return <div className="auth">
    {state === 'loading' && <p className="muted">Gerando o QR code…</p>}
    {state === 'waiting' && req && <>
      <p>No celular já logado, abra o app em <strong>Ajustes → Aparelhos → Aprovar acesso</strong> e leia este QR code (ou digite o código abaixo).</p>
      {img && <img src={img} alt="QR code para aprovar este acesso" style={{ width: 240, background: '#fff', justifySelf: 'center' }} />}
      <p style={{ textAlign: 'center', margin: 0 }}>Código: <strong style={{ fontSize: 20, letterSpacing: 2 }}>{formatPairCode(req.pairCode)}</strong></p>
      <p style={{ textAlign: 'center', margin: 0 }}>No celular, escolha o número <strong style={{ fontSize: 28 }}>{req.matchCode}</strong></p>
      <p className="muted" style={{ fontSize: 12, textAlign: 'center' }}>Vale por {left}s. Acesso pontual: termina ao fechar esta aba ou em 12 horas.</p>
    </>}
    {state === 'entering' && <p className="muted">Aprovado. Entrando…</p>}
    {state === 'ended' && <button type="button" className="primary" onClick={() => setRound((n) => n + 1)}>Gerar outro QR code</button>}
    {error && <p className="err">{error}</p>}
    <button type="button" onClick={onCancel}>Voltar</button>
  </div>
}

/** Câmera traseira lendo QR codes; chama onCode com o primeiro código de pareamento válido. */
function Scanner({ onCode }: { onCode: (code: string) => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string | null>(null)
  const found = useRef(onCode)
  useEffect(() => { found.current = onCode }, [onCode])
  useEffect(() => {
    let stream: MediaStream | null = null
    let frame = 0
    let done = false
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    const scan = () => {
      const v = video.current
      if (done || !v || !ctx) return
      if (v.readyState === v.HAVE_ENOUGH_DATA && v.videoWidth) {
        canvas.width = v.videoWidth; canvas.height = v.videoHeight
        ctx.drawImage(v, 0, 0)
        const hit = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' })
        const code = hit && normalizePairCode(hit.data)
        if (code) { done = true; found.current(code); return }
      }
      frame = requestAnimationFrame(scan)
    }
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'environment' }, audio: false }).then((s) => {
      stream = s
      if (done || !video.current) { s.getTracks().forEach((t) => t.stop()); return }
      video.current.srcObject = s
      video.current.play().catch(() => { /* iOS: play() after the stream; muted+playsInline allow it */ })
      frame = requestAnimationFrame(scan)
    }, () => setError('Sem acesso à câmera. Permita a câmera para este app, ou digite o código.'))
    if (!navigator.mediaDevices) setError('Este navegador não dá acesso à câmera. Digite o código.')
    return () => { done = true; cancelAnimationFrame(frame); stream?.getTracks().forEach((t) => t.stop()) }
  }, [])
  return <div>
    <video ref={video} muted playsInline style={{ width: '100%', maxWidth: 320, borderRadius: 8, background: '#000', display: 'block', margin: '0 auto' }} />
    {error && <p className="warn">{error}</p>}
  </div>
}

/**
 * No celular já logado (aal2): lê o QR code (ou o código digitado), mostra quem pediu, pede o número
 * que o outro aparelho mostra e uma nova confirmação (biometria ou código) antes de aprovar.
 */
export function QrApprove({ initialCode, onClose }: { initialCode?: string | null; onClose: () => void }) {
  const [code, setCode] = useState<string | null>(initialCode ? normalizePairCode(initialCode) : null)
  const [typed, setTyped] = useState('')
  const [scan, setScan] = useState(false)
  const [info, setInfo] = useState<QrInfo | null>(null)
  const [pick, setPick] = useState<number | null>(null)
  const [totp, setTotp] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const mine = biometricSupported() ? thisDeviceFactor() : null

  useEffect(() => {
    if (!code) return
    setInfo(null); setError(null); setPick(null)
    qrInfo(code).then(setInfo, (e) => setError(msg(e)))
  }, [code])

  /** Biometria deste aparelho ou o código do autenticador: o servidor exige uma confirmação recente. */
  async function confirmar(): Promise<boolean> {
    if (mine && !totp.trim()) return authenticateBiometric(mine)
    const { data: f } = await supabase.auth.mfa.listFactors()
    const factor = f?.totp.find((x) => x.status === 'verified')
    if (!factor) throw new Error('confirme_biometria')
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code: totp.trim() })
    if (error) throw new Error('Código do autenticador inválido.')
    return true
  }

  async function aprovar() {
    if (!code || pick === null) return setError('Escolha o número que aparece no outro aparelho.')
    if (!mine && !/^\d{6}$/.test(totp.trim())) return setError('Digite o código de 6 dígitos do autenticador.')
    setBusy(true); setError(null)
    try {
      if (!(await confirmar())) return
      await approveQr(code, pick)
      setDone('Acesso aprovado. O outro aparelho entra em alguns segundos, como acesso pontual.')
    } catch (e) { setError(msg(e)) } finally { setBusy(false); setTotp('') }
  }

  async function negar() {
    if (!code) return
    setBusy(true); setError(null)
    try { await denyQr(code); setDone('Pedido negado. Se não foi você, troque a senha em Ajustes → Aparelhos.') } catch (e) { setError(msg(e)) } finally { setBusy(false) }
  }

  const onScanned = (c: string) => { setScan(false); setCode(c) }

  return <div className="lock">
    <div className="card auth" style={{ maxWidth: 420 }}>
      <h3>Aprovar acesso de outro aparelho</h3>
      {done ? <><p className="pos">✔ {done}</p><button type="button" className="primary" onClick={onClose}>Fechar</button></> : <>
        {!code && <>
          {scan ? <Scanner onCode={onScanned} /> : <button type="button" className="primary" onClick={() => setScan(true)}>Ler QR code com a câmera</button>}
          <p className="muted" style={{ fontSize: 12, textAlign: 'center', margin: 0 }}>ou digite o código mostrado no outro aparelho:</p>
          <form className="auth" onSubmit={(e) => { e.preventDefault(); const c = normalizePairCode(typed); if (c) setCode(c); else setError(qrError('codigo_invalido')) }}>
            <input autoCapitalize="characters" autoComplete="off" placeholder="XXXX-XXXX" value={typed} onChange={(e) => setTyped(e.target.value)} />
            <button>Continuar</button>
          </form>
        </>}
        {code && !info && !error && <p className="muted">Buscando o pedido {formatPairCode(code)}…</p>}
        {info && <>
          <p style={{ margin: 0 }}>Pedido de <strong>{info.requester.os || 'aparelho'} · {info.requester.browser || 'navegador'}</strong>
            {info.requester.ip ? <> (IP {info.requester.ip})</> : null}, às {new Date(info.createdAt).toLocaleTimeString('pt-BR', { timeStyle: 'short' })}.</p>
          <p className="warn" style={{ margin: 0, fontSize: 13 }}>Só aprove se foi você, agora, na frente desse aparelho. Ninguém do suporte pede isso.</p>
          <p style={{ margin: 0 }}>Qual número aparece no outro aparelho?</p>
          <div className="row" style={{ justifyContent: 'center' }}>
            {info.choices.map((n) => <button key={n} type="button" className={pick === n ? 'active' : ''} aria-pressed={pick === n} style={{ fontSize: 22, minWidth: 64 }} onClick={() => setPick(n)}>{n}</button>)}
          </div>
          {mine
            ? <p className="muted" style={{ fontSize: 12, margin: 0 }}>Ao aprovar, confirme com Face ID / digital. Ou digite o código do autenticador:</p>
            : <p className="muted" style={{ fontSize: 12, margin: 0 }}>Confirme com o código do autenticador:</p>}
          <input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" placeholder="Código de 6 dígitos" value={totp} onChange={(e) => setTotp(e.target.value)} />
          <button type="button" className="primary" disabled={busy || pick === null} onClick={aprovar}>{busy ? 'Aprovando…' : 'Aprovar acesso pontual'}</button>
          <button type="button" disabled={busy} onClick={negar}>Não fui eu: negar</button>
        </>}
        {error && <p className="err">{error}</p>}
        {code && error && <button type="button" onClick={() => { setCode(null); setTyped(''); setError(null) }}>Tentar outro código</button>}
        <button type="button" onClick={onClose}>Cancelar</button>
      </>}
    </div>
  </div>
}

/** Ajustes → Aparelhos: aprovar um acesso por QR e ver/revogar os acessos pontuais ativos. */
export function QrAccessCard() {
  const [list, setList] = useState<ApprovedSession[] | null | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = () => activeApprovals().then(setList, () => setList(null))
  useEffect(() => { load() }, [open])

  return <div className="card">
    <h3>Acesso pelo celular (QR code)</h3>
    <p className="muted" style={{ fontSize: 13 }}>Para entrar num aparelho sem senha nem e-mail: lá, toque em “Entrar com o celular (QR code)”; aqui, leia o QR code. O acesso é pontual: termina ao fechar a aba ou em 12 horas.</p>
    <div className="row"><button className="primary" onClick={() => setOpen(true)}>Aprovar acesso (ler QR code)</button></div>
    {list === null && <p className="warn" style={{ marginTop: 8 }}>Rode <code>supabase/migrations/010_qr_login.sql</code> no SQL Editor do Supabase e publique a função <code>qr-login</code>.</p>}
    {list && list.length > 0 && <div className="scroll" style={{ marginTop: 8 }}><table>
      <thead><tr><th>Aparelho</th><th>Aprovado</th><th>Até</th><th /></tr></thead>
      <tbody>{list.map((s) => <tr key={s.session_id}>
        <td>{s.requester.os || '—'} · {s.requester.browser || '—'}{s.requester.ip && <div className="muted" style={{ fontSize: 12 }}>IP {s.requester.ip}</div>}</td>
        <td>{quando(s.approved_at)}</td><td>{quando(s.expires_at)}</td>
        <td><button onClick={() => { setError(null); revokeApproval(s.session_id).then(load, (e) => setError((e as Error).message)) }}>Revogar</button></td>
      </tr>)}</tbody>
    </table></div>}
    {list && list.length === 0 && <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>Nenhum acesso pontual ativo.</p>}
    {error && <p className="err">{error}</p>}
    {open && <QrApprove onClose={() => setOpen(false)} />}
  </div>
}
