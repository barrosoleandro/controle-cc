import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { noteSignedIn, noteSignedOut, setTrust, signOutWith, tabSignedIn, trustUntil } from '../lib/trust'
import { reauthNeeded } from '../domain/device'
import { VERSION, versionLabel } from '../lib/version'
import { authenticateBiometric, biometricFactors, biometricSupported, orderForThisDevice, thisDeviceFactor } from '../lib/biometric'
import type { Factor } from '@supabase/supabase-js'

type Step = 'loading' | 'login' | 'code' | 'reset' | 'enroll' | 'verify' | 'newpass' | 'ok'
type Metodo = 'senha' | 'email'

export const APP_NAME = 'Finanças Pessoais'
const RECOVERY_PARAM = 'recuperar' // marks the return from the reset e-mail link

/**
 * Entrada por senha ou por código enviado no e-mail, sempre seguida de TOTP.
 * A sessão só serve para alguma coisa com verificação em duas etapas (aal2):
 * quem garante isso é o RLS no banco, esta tela é só a porta.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const [step, setStep] = useState<Step>('loading')
  const [metodo, setMetodo] = useState<Metodo>('senha')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [emailCode, setEmailCode] = useState('')
  const [qr, setQr] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [factorId, setFactorId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [lembrar, setLembrar] = useState<boolean | null>(null) // asked every time, no default
  const [bio, setBio] = useState<Factor[]>([]) // biometrics registered on the account, this device's first
  // Back from the reset link: the link only signs in (aal1); the new password is asked after the TOTP.
  const [recuperando] = useState(() => new URLSearchParams(window.location.search).has(RECOVERY_PARAM))
  const [novaSenha, setNovaSenha] = useState('')
  const [confirmaSenha, setConfirmaSenha] = useState('')

  async function evaluate() {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return setStep('login')
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (aal?.currentLevel === 'aal2') {
      // Saved device 30 days unused, or a one-off access reopened: the full login again.
      const why = reauthNeeded({ trustUntil: trustUntil(), now: Date.now(), tabSignedIn: tabSignedIn() })
      if (why) { await signOutWith(why); return }
      return setStep(recuperando ? 'newpass' : 'ok')
    }
    const { data: factors } = await supabase.auth.mfa.listFactors()
    const totp = factors?.totp.find((f) => f.status === 'verified')
    if (totp) {
      setFactorId(totp.id)
      if (biometricSupported()) setBio(orderForThisDevice(await biometricFactors()))
      return setStep('verify')
    }
    // Limpa cadastros pela metade e registra um novo autenticador.
    for (const f of factors?.all ?? []) if (f.status !== 'verified') await supabase.auth.mfa.unenroll({ factorId: f.id })
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: APP_NAME })
    if (error) { setError(error.message); return setStep('login') }
    setFactorId(data.id); setQr(data.totp.qr_code); setSecret(data.totp.secret)
    setStep('enroll')
  }

  useEffect(() => {
    evaluate()
    const { data } = supabase.auth.onAuthStateChange((e) => { if (e === 'SIGNED_OUT') { noteSignedOut(); setTrust(false); setStep('login') } })
    return () => data.subscription.unsubscribe()
  }, [])

  async function entrarComSenha(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setPassword('')
    setBusy(false)
    if (error) return setError('Não foi possível entrar.') // mensagem genérica de propósito
    await evaluate()
  }

  async function pedirCodigo(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null); setInfo(null)
    // shouldCreateUser: false — cadastro público está desligado, ninguém se cria por aqui.
    const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } })
    setBusy(false)
    if (error) return setError('Não foi possível enviar o código.')
    setInfo(`Enviamos um código de 6 dígitos para ${email}. Ele vale poucos minutos.`)
    setStep('code')
  }

  async function entrarComCodigo(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null)
    const { error } = await supabase.auth.verifyOtp({ email, token: emailCode.trim(), type: 'email' })
    setBusy(false); setEmailCode('')
    if (error) return setError('Código inválido ou expirado.')
    await evaluate()
  }

  async function pedirReset(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null); setInfo(null)
    const redirectTo = `${window.location.origin}${window.location.pathname}?${RECOVERY_PARAM}=1`
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo })
    setBusy(false)
    if (error) return setError('Não foi possível enviar o link.')
    // Same message whether or not the e-mail exists, on purpose.
    setInfo(`Se ${email} tiver conta, enviamos um link para criar uma senha nova. Abra-o neste navegador.`)
  }

  async function salvarSenha(e: React.FormEvent) {
    e.preventDefault(); setError(null)
    if (novaSenha !== confirmaSenha) return setError('As senhas não conferem.')
    setBusy(true)
    const { error } = await supabase.auth.updateUser({ password: novaSenha })
    setBusy(false); setNovaSenha(''); setConfirmaSenha('')
    if (error) return setError(`Não foi possível trocar a senha: ${error.message}`)
    window.history.replaceState(null, '', window.location.pathname)
    setStep('ok')
  }

  const semEscolha = () => { if (lembrar !== null) return false; setError('Escolha antes: salvar este aparelho ou só desta vez.'); return true }

  async function entrarComBiometria(id: string, phone: boolean) {
    if (semEscolha()) return
    setBusy(true); setError(null)
    try {
      if (!(await authenticateBiometric(id, phone))) return
      noteSignedIn(lembrar === true)
      setStep(recuperando ? 'newpass' : 'ok')
    } catch { setError('A biometria não funcionou neste aparelho. Use o código do autenticador.') }
    finally { setBusy(false) }
  }

  async function verificarTotp(e: React.FormEvent) {
    e.preventDefault(); if (!factorId || semEscolha()) return
    setBusy(true); setError(null)
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.trim() })
    setBusy(false); setCode('')
    if (error) return setError('Código inválido.')
    noteSignedIn(lembrar === true)
    setStep(recuperando ? 'newpass' : 'ok')
  }

  if (step === 'ok') return <>{children}</>
  return (
    <div className="center">
      <div className="card auth">
        <h3>{APP_NAME}</h3>
        {step === 'loading' && <p className="muted">Carregando…</p>}

        {step === 'login' && <>
          <div className="row">
            <button className={metodo === 'senha' ? 'active' : ''} onClick={() => { setMetodo('senha'); setError(null) }}>Senha</button>
            <button className={metodo === 'email' ? 'active' : ''} onClick={() => { setMetodo('email'); setError(null) }}>Código por e-mail</button>
          </div>
          {metodo === 'senha' ? (
            <form onSubmit={entrarComSenha} className="auth">
              <input type="email" name="email" id="email" autoComplete="username" placeholder="E-mail" value={email} onChange={(e) => setEmail(e.target.value)} required />
              <input type="password" name="password" id="password" autoComplete="current-password" placeholder="Senha" value={password} onChange={(e) => setPassword(e.target.value)} required />
              <button type="submit" className="primary" disabled={busy}>Entrar</button>
              <button type="button" className="link" onClick={() => { setStep('reset'); setError(null); setInfo(null) }}>Esqueci minha senha</button>
            </form>
          ) : (
            <form onSubmit={pedirCodigo} className="auth">
              <input type="email" autoComplete="username" placeholder="E-mail" value={email} onChange={(e) => setEmail(e.target.value)} required />
              <button className="primary" disabled={busy}>Enviar código</button>
              <p className="muted" style={{ fontSize: 12 }}>Sem senha: você recebe um código no e-mail. A verificação em duas etapas continua sendo pedida depois.</p>
            </form>
          )}
        </>}

        {step === 'code' && (
          <form onSubmit={entrarComCodigo} className="auth">
            {info && <p className="muted">{info}</p>}
            <input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" placeholder="Código do e-mail" value={emailCode} onChange={(e) => setEmailCode(e.target.value)} required />
            <button className="primary" disabled={busy}>Confirmar</button>
            <button type="button" onClick={() => { setStep('login'); setError(null); setInfo(null) }}>Voltar</button>
          </form>
        )}

        {step === 'reset' && (
          <form onSubmit={pedirReset} className="auth">
            <p className="muted">Enviamos um link para o seu e-mail. Depois de abrir o link, o app pede o código do autenticador e a senha nova.</p>
            <input type="email" autoComplete="username" placeholder="E-mail" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <button className="primary" disabled={busy}>Enviar link</button>
            {info && <p className="muted">{info}</p>}
            <button type="button" onClick={() => { setStep('login'); setError(null); setInfo(null) }}>Voltar</button>
          </form>
        )}

        {step === 'newpass' && (
          <form onSubmit={salvarSenha} className="auth">
            <p>Escolha a senha nova.</p>
            <input type="password" autoComplete="new-password" placeholder="Senha nova" minLength={8} value={novaSenha} onChange={(e) => setNovaSenha(e.target.value)} required autoFocus />
            <input type="password" autoComplete="new-password" placeholder="Repita a senha nova" minLength={8} value={confirmaSenha} onChange={(e) => setConfirmaSenha(e.target.value)} required />
            <button className="primary" disabled={busy}>Salvar senha</button>
            <button type="button" onClick={() => signOutWith('manual')}>Cancelar</button>
          </form>
        )}

        {(step === 'enroll' || step === 'verify') && (
          <form onSubmit={verificarTotp} className="auth">
            {step === 'enroll' && <>
              <p>A verificação em duas etapas é obrigatória. Escaneie com o Google Authenticator / Microsoft Authenticator / 1Password:</p>
              {qr && <img src={qr} alt="QR code do TOTP" style={{ width: 200, background: '#fff', justifySelf: 'center' }} />}
              <p className="muted" style={{ wordBreak: 'break-all', fontSize: 12 }}>Chave manual: {secret}</p>
            </>}
            <Escolha lembrar={lembrar} onChange={(v) => { setLembrar(v); setError(null) }} />
            {step === 'verify' && bio.length > 0 && <>
              <BioButtons factors={bio} busy={busy} onPick={entrarComBiometria} />
              <p className="muted" style={{ fontSize: 12, textAlign: 'center' }}>ou o código do autenticador:</p>
            </>}
            <input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" placeholder="Código de 6 dígitos" value={code} onChange={(e) => setCode(e.target.value)} required={!bio.length} />
            <button className="primary" disabled={busy}>Verificar</button>
            <button type="button" onClick={() => signOutWith('manual')}>Cancelar</button>
          </form>
        )}
        {error && <p className="err">{error}</p>}
        <Versao />
      </div>
    </div>
  )
}

/**
 * Which build is running, before signing in: the installed app may still be on the cached one.
 * "Atualizar" asks the server for a new build and reloads (autoUpdate installs it right away).
 */
function Versao() {
  const [busy, setBusy] = useState(false)
  async function atualizar() {
    setBusy(true)
    try { await (await navigator.serviceWorker?.getRegistration())?.update() } catch { /* offline: just reload */ }
    window.location.reload()
  }
  return <p className="muted" style={{ fontSize: 11, textAlign: 'center', margin: '8px 0 0' }} title={VERSION.message}>
    {versionLabel()} · <button type="button" className="link" style={{ fontSize: 11 }} disabled={busy} onClick={atualizar}>{busy ? 'atualizando…' : 'atualizar'}</button>
  </p>
}

/**
 * Tela de bloqueio por inatividade. A sessão é mantida, então voltar custa só o
 * código do autenticador — sem e-mail e sem senha. Depois de mais tempo parado,
 * quem desloga de verdade é o App.
 */
export function ReauthLock({ onUnlock }: { onUnlock: () => void }) {
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [bio, setBio] = useState<Factor[]>([])
  useEffect(() => { if (biometricSupported()) biometricFactors().then((f) => setBio(orderForThisDevice(f)), () => setBio([])) }, [])
  async function comBiometria(id: string, phone: boolean) {
    setBusy(true); setError(null)
    try { if (await authenticateBiometric(id, phone)) onUnlock() } catch { setError('A biometria não funcionou. Use o código.') } finally { setBusy(false) }
  }

  async function desbloquear(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null)
    const { data: factors } = await supabase.auth.mfa.listFactors()
    const totp = factors?.totp.find((f) => f.status === 'verified')
    if (!totp) { setBusy(false); return signOutWith('servidor') }
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: totp.id, code: code.trim() })
    setBusy(false); setCode('')
    if (error) return setError('Código inválido.')
    onUnlock()
  }

  return (
    <div className="lock">
      <div className="card auth">
        <h3>Tela bloqueada</h3>
        <p className="muted">Você ficou um tempo sem usar o app. Digite o código do autenticador para voltar.</p>
        {bio.length > 0 && <BioButtons factors={bio} busy={busy} onPick={comBiometria} />}
        <form onSubmit={desbloquear} className="auth">
          <input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" placeholder="Código de 6 dígitos"
            value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
          <button className="primary" disabled={busy}>Desbloquear</button>
          <button type="button" onClick={() => signOutWith('manual')}>Sair da conta</button>
        </form>
        {error && <p className="err">{error}</p>}
      </div>
    </div>
  )
}

/** "Salvar este aparelho" or "Só desta vez": asked on every sign-in, with nothing chosen beforehand. */
function Escolha({ lembrar, onChange }: { lembrar: boolean | null; onChange: (v: boolean) => void }) {
  return <div className="auth">
    <p style={{ margin: 0 }}>Este acesso é:</p>
    <div className="row">
      <button type="button" className={lembrar === true ? 'active' : ''} aria-pressed={lembrar === true} onClick={() => onChange(true)}>Salvar este aparelho</button>
      <button type="button" className={lembrar === false ? 'active' : ''} aria-pressed={lembrar === false} onClick={() => onChange(false)}>Só desta vez</button>
    </div>
    <p className="muted" style={{ fontSize: 12 }}>
      {lembrar === false
        ? 'Só desta vez: ao fechar o app ou o navegador, o login completo (senha + código) é pedido de novo; parado por 15 min, a tela trava.'
        : 'Salvar só em aparelho seu: o app abre direto, sem senha nem código, enquanto for usado ao menos uma vez a cada 30 dias. Dá para revogar em Ajustes → Aparelhos.'}
    </p>
  </div>
}

/**
 * Biometric sign-in: this device's own key (Face ID / digital), and on a computer one QR button per
 * other registered device, approved on the phone. When the browser forgot which key is its own
 * (data wiped), every key is offered both ways.
 */
function BioButtons({ factors, busy, onPick }: { factors: Factor[]; busy: boolean; onPick: (id: string, phone: boolean) => void }) {
  const mineId = thisDeviceFactor()
  const mine = factors.find((f) => f.id === mineId)
  const others = factors.filter((f) => f.id !== mineId)
  const computer = !/Android|iPhone|iPad/.test(navigator.userAgent)
  return <div className="auth">
    {mine && <button type="button" className="primary" disabled={busy} onClick={() => onPick(mine.id, false)}>Entrar com biometria (Face ID / digital)</button>}
    {computer && others.map((f) => <button key={`qr-${f.id}`} type="button" className={mine ? '' : 'primary'} disabled={busy} onClick={() => onPick(f.id, true)}>
      Aprovar pelo celular (QR code) · {f.friendly_name || 'aparelho'}</button>)}
    {!mine && !computer && others.map((f) => <button key={f.id} type="button" disabled={busy} onClick={() => onPick(f.id, false)}>Biometria · {f.friendly_name || 'aparelho'}</button>)}
    {computer && others.length > 0 && <p className="muted" style={{ fontSize: 12 }}>O navegador mostra um QR code: leia com a câmera do celular e confirme com Face ID / digital. Bluetooth ligado nos dois.</p>}
  </div>
}
