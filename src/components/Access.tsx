import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import jsQR from 'jsqr'
import { supabase } from '../lib/supabase'
import { noteSignedIn } from '../lib/trust'
import { accessError, approveUrl, formatPairCode, normalizePairCode, PLAN_TEXT } from '../domain/access'
import { accessInfo, approveAccess, denyAccess, household, pollAccess, removeMember, signInWithToken, startAccess, type AccessInfo, type AccessStart, type Member } from '../lib/access'

const POLL_MS = 2000
const msg = (e: unknown) => accessError((e as Error).message)
const quando = (iso: string) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })

/**
 * No aparelho sem login: a pessoa informa o e-mail, o app mostra o QR code e o número de conferência,
 * e espera o dono da casa aprovar no celular dele. Aprovado, entra.
 */
export function AccessRequest({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [email, setEmail] = useState('')
  const [lembrar, setLembrar] = useState(true)
  const [req, setReq] = useState<AccessStart | null>(null)
  const [img, setImg] = useState<string | null>(null)
  const [state, setState] = useState<'form' | 'loading' | 'waiting' | 'entering' | 'ended'>('form')
  const [error, setError] = useState<string | null>(null)
  const [left, setLeft] = useState(0)
  const done = useRef(onDone)
  useEffect(() => { done.current = onDone }, [onDone])
  const keep = useRef(lembrar)
  useEffect(() => { keep.current = lembrar }, [lembrar])

  async function pedir(e?: React.FormEvent) {
    e?.preventDefault()
    setState('loading'); setError(null); setReq(null); setImg(null)
    try {
      const s = await startAccess(email.trim())
      setReq(s)
      setImg(await QRCode.toDataURL(approveUrl(window.location.origin, s.pairCode), { margin: 1, width: 240 }))
      setState('waiting')
    } catch (err) { setError(msg(err)); setState('form') }
  }

  useEffect(() => {
    if (!req || state !== 'waiting') return
    let busy = false
    const tick = async () => {
      setLeft(Math.max(0, Math.round((Date.parse(req.expiresAt) - Date.now()) / 1000)))
      if (busy) return
      busy = true
      try {
        const r = await pollAccess(req)
        if (r.status === 'approved') {
          setState('entering')
          await signInWithToken(r.tokenHash)
          noteSignedIn(keep.current)
          done.current()
        } else if (r.status !== 'pending') {
          setError(r.status === 'denied' ? 'O pedido foi negado (ou o número escolhido estava errado).' : 'O QR code expirou ou já foi usado.')
          setState('ended')
        }
      } catch (e) { setError(msg(e)); setState('ended') } finally { busy = false }
    }
    tick()
    const t = window.setInterval(tick, POLL_MS)
    return () => clearInterval(t)
  }, [req, state])

  return <div className="auth">
    {state === 'form' && <form onSubmit={pedir} className="auth">
      <p>Sem senha: quem já usa o app aprova pelo celular. Informe o seu e-mail (não é preciso abrir a caixa de entrada).</p>
      <input type="email" autoComplete="username" placeholder="Seu e-mail" value={email} onChange={(e) => setEmail(e.target.value)} required />
      <label className="inline"><input type="checkbox" checked={lembrar} onChange={(e) => setLembrar(e.target.checked)} /> Lembrar neste aparelho</label>
      <button className="primary">Pedir acesso</button>
    </form>}
    {state === 'loading' && <p className="muted">Gerando o QR code…</p>}
    {state === 'waiting' && req && <>
      <p>Peça a quem já usa o app para abrir <strong>Ajustes → Aparelhos → Aprovar acesso</strong> no celular e ler este QR code (ou digitar o código).</p>
      {img && <img src={img} alt="QR code para aprovar este acesso" style={{ width: 240, background: '#fff', justifySelf: 'center' }} />}
      <p style={{ textAlign: 'center', margin: 0 }}>Código: <strong style={{ fontSize: 20, letterSpacing: 2 }}>{formatPairCode(req.pairCode)}</strong></p>
      <p style={{ textAlign: 'center', margin: 0 }}>No celular, escolha o número <strong style={{ fontSize: 28 }}>{req.matchCode}</strong></p>
      <p className="muted" style={{ fontSize: 12, textAlign: 'center' }}>Vale por {left}s.</p>
    </>}
    {state === 'entering' && <p className="muted">Aprovado. Entrando…</p>}
    {state === 'ended' && <button type="button" className="primary" onClick={() => pedir()}>Pedir de novo</button>}
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
    if (!navigator.mediaDevices) setError('Este navegador não dá acesso à câmera. Digite o código.')
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'environment' }, audio: false }).then((s) => {
      stream = s
      if (done || !video.current) { s.getTracks().forEach((t) => t.stop()); return }
      video.current.srcObject = s
      video.current.play().catch(() => { /* iOS: muted + playsInline let it play */ })
      frame = requestAnimationFrame(scan)
    }, () => setError('Sem acesso à câmera. Permita a câmera para este app, ou digite o código.'))
    return () => { done = true; cancelAnimationFrame(frame); stream?.getTracks().forEach((t) => t.stop()) }
  }, [])
  return <div>
    <video ref={video} muted playsInline style={{ width: '100%', maxWidth: 320, borderRadius: 8, background: '#000', display: 'block', margin: '0 auto' }} />
    {error && <p className="warn">{error}</p>}
  </div>
}

/**
 * No celular do dono da casa, logado: lê o QR code (ou o código digitado), mostra quem pediu e o que
 * a aprovação vai fazer, pede o número que o outro aparelho mostra e aprova.
 */
export function AccessApprove({ initialCode, onClose }: { initialCode?: string | null; onClose: () => void }) {
  const [code, setCode] = useState<string | null>(initialCode ? normalizePairCode(initialCode) : null)
  const [typed, setTyped] = useState('')
  const [scan, setScan] = useState(false)
  const [info, setInfo] = useState<AccessInfo | null>(null)
  const [pick, setPick] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  useEffect(() => {
    if (!code) return
    let alive = true
    accessInfo(code).then((i) => { if (alive) { setInfo(i); setPick(null) } }, (e) => { if (alive) setError(msg(e)) })
    return () => { alive = false }
  }, [code])

  async function aprovar() {
    if (!code || pick === null) return setError('Escolha o número que aparece no outro aparelho.')
    setBusy(true); setError(null)
    try {
      const r = await approveAccess(code, pick)
      setDone(r.created ? 'Conta criada e incluída na sua casa. O outro aparelho entra em alguns segundos.' : 'Acesso aprovado. O outro aparelho entra em alguns segundos.')
    } catch (e) { setError(msg(e)) } finally { setBusy(false) }
  }

  async function negar() {
    if (!code) return
    setBusy(true); setError(null)
    try { await denyAccess(code); setDone('Pedido negado.') } catch (e) { setError(msg(e)) } finally { setBusy(false) }
  }

  const blocked = info && (info.plan === 'so_dono' || info.plan === 'conta_de_outra_casa')
  const recomeçar = () => { setCode(null); setTyped(''); setInfo(null); setError(null) }

  return <div className="lock">
    <div className="card auth" style={{ maxWidth: 420 }}>
      <h3>Aprovar acesso</h3>
      {done ? <><p className="pos">✔ {done}</p><button type="button" className="primary" onClick={onClose}>Fechar</button></> : <>
        {!code && <>
          {scan ? <Scanner onCode={(c) => { setScan(false); setCode(c) }} /> : <button type="button" className="primary" onClick={() => setScan(true)}>Ler QR code com a câmera</button>}
          <p className="muted" style={{ fontSize: 12, textAlign: 'center', margin: 0 }}>ou digite o código mostrado no outro aparelho:</p>
          <form className="auth" onSubmit={(e) => { e.preventDefault(); const c = normalizePairCode(typed); if (c) { setError(null); setCode(c) } else setError(accessError('codigo_invalido')) }}>
            <input autoCapitalize="characters" autoComplete="off" placeholder="XXXX-XXXX" value={typed} onChange={(e) => setTyped(e.target.value)} />
            <button>Continuar</button>
          </form>
        </>}
        {code && !info && !error && <p className="muted">Buscando o pedido {formatPairCode(code)}…</p>}
        {info && <>
          <p style={{ margin: 0 }}><strong>{info.email}</strong> pede acesso de <strong>{info.requester.os || 'aparelho'} · {info.requester.browser || 'navegador'}</strong>
            {info.requester.ip ? <> (IP {info.requester.ip})</> : null}, às {new Date(info.createdAt).toLocaleTimeString('pt-BR', { timeStyle: 'short' })}.</p>
          <p className={blocked ? 'err' : 'muted'} style={{ margin: 0, fontSize: 13 }}>{PLAN_TEXT[info.plan] ?? ''}</p>
          {!blocked && <>
            <p className="warn" style={{ margin: 0, fontSize: 13 }}>Só aprove se a pessoa está com você, agora, na frente desse aparelho.</p>
            <p style={{ margin: 0 }}>Qual número aparece no outro aparelho?</p>
            <div className="row" style={{ justifyContent: 'center' }}>
              {info.choices.map((n) => <button key={n} type="button" className={pick === n ? 'active' : ''} aria-pressed={pick === n} style={{ fontSize: 22, minWidth: 64 }} onClick={() => setPick(n)}>{n}</button>)}
            </div>
            <button type="button" className="primary" disabled={busy || pick === null} onClick={aprovar}>{busy ? 'Aprovando…' : 'Aprovar'}</button>
          </>}
          <button type="button" disabled={busy} onClick={negar}>Negar</button>
        </>}
        {error && <p className="err">{error}</p>}
        {code && error && <button type="button" onClick={recomeçar}>Tentar outro código</button>}
        <button type="button" onClick={onClose}>Cancelar</button>
      </>}
    </div>
  </div>
}

/** Ajustes → Aparelhos: aprovar o acesso de alguém e ver/remover as pessoas da casa. */
export function HouseholdCard() {
  const [me, setMe] = useState<string | null>(null)
  const [list, setList] = useState<Member[] | null | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = () => household().then(setList, () => setList(null))
  useEffect(() => { supabase.auth.getUser().then(({ data }) => setMe(data.user?.id ?? null)); load() }, [open])

  const sou = list?.find((m) => m.member_id === me) // sou membro da casa de alguém
  const membros = (list ?? []).filter((m) => m.owner_id === me)

  async function remover(m: Member) {
    if (!confirm(`Remover ${m.email ?? 'esta pessoa'} da casa? A conta dela é apagada e o acesso termina; os dados da casa ficam.`)) return
    setError(null)
    try { await removeMember(m.member_id); await load() } catch (e) { setError(msg(e)) }
  }

  return <div className="card">
    <h3>Pessoas da casa</h3>
    {sou
      ? <p className="muted" style={{ fontSize: 13 }}>Você faz parte de uma casa compartilhada: vê e edita os mesmos dados do dono. Só o dono aprova novos acessos.</p>
      : <>
        <p className="muted" style={{ fontSize: 13 }}>Para alguém entrar sem senha nem e-mail: no aparelho dela, “Pedir acesso pelo celular”; aqui, leia o QR code. Pessoa nova entra na sua casa e vê e edita todos os dados.</p>
        <div className="row"><button className="primary" onClick={() => setOpen(true)}>Aprovar acesso (ler QR code)</button></div>
      </>}
    {list === null && <p className="warn" style={{ marginTop: 8 }}>Rode <code>supabase/migrations/011_household.sql</code> e <code>012_access_requests.sql</code> no SQL Editor do Supabase e publique a função <code>household-access</code>.</p>}
    {membros.length > 0 && <div className="scroll" style={{ marginTop: 8 }}><table>
      <thead><tr><th>Pessoa</th><th>Desde</th><th /></tr></thead>
      <tbody>{membros.map((m) => <tr key={m.member_id}>
        <td>{m.email ?? m.member_id.slice(0, 8)}</td><td>{quando(m.created_at)}</td>
        <td><button className="link" onClick={() => remover(m)}>Remover</button></td>
      </tr>)}</tbody>
    </table></div>}
    {list && !sou && membros.length === 0 && <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>Ninguém mais na casa.</p>}
    {error && <p className="err">{error}</p>}
    {open && <AccessApprove onClose={() => setOpen(false)} />}
  </div>
}
