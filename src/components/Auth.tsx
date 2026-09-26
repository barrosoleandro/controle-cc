import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { setTrust, trustUntil, trustedDevice } from '../lib/trust'

type Step = 'loading' | 'login' | 'code' | 'enroll' | 'verify' | 'ok'
type Metodo = 'senha' | 'email'

export const APP_NAME = 'Finanças Pessoais'

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
  const [lembrar, setLembrar] = useState(true)

  async function evaluate() {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return setStep('login')
    // Os 30 dias acabaram: pede o login completo de novo.
    if (trustUntil() && !trustedDevice()) { await supabase.auth.signOut(); return }
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (aal?.currentLevel === 'aal2') return setStep('ok')
    const { data: factors } = await supabase.auth.mfa.listFactors()
    const totp = factors?.totp.find((f) => f.status === 'verified')
    if (totp) { setFactorId(totp.id); return setStep('verify') }
    // Limpa cadastros pela metade e registra um novo autenticador.
    for (const f of factors?.all ?? []) if (f.status !== 'verified') await supabase.auth.mfa.unenroll({ factorId: f.id })
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: APP_NAME })
    if (error) { setError(error.message); return setStep('login') }
    setFactorId(data.id); setQr(data.totp.qr_code); setSecret(data.totp.secret)
    setStep('enroll')
  }

  useEffect(() => {
    evaluate()
    const { data } = supabase.auth.onAuthStateChange((e) => { if (e === 'SIGNED_OUT') { setTrust(false); setStep('login') } })
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

  async function verificarTotp(e: React.FormEvent) {
    e.preventDefault(); if (!factorId) return
    setBusy(true); setError(null)
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.trim() })
    setBusy(false); setCode('')
    if (error) return setError('Código inválido.')
    setTrust(lembrar)
    setStep('ok')
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

        {(step === 'enroll' || step === 'verify') && (
          <form onSubmit={verificarTotp} className="auth">
            {step === 'enroll' && <>
              <p>A verificação em duas etapas é obrigatória. Escaneie com o Google Authenticator / Microsoft Authenticator / 1Password:</p>
              {qr && <img src={qr} alt="QR code do TOTP" style={{ width: 200, background: '#fff', justifySelf: 'center' }} />}
              <p className="muted" style={{ wordBreak: 'break-all', fontSize: 12 }}>Chave manual: {secret}</p>
            </>}
            <input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" placeholder="Código de 6 dígitos" value={code} onChange={(e) => setCode(e.target.value)} required />
            <label className="inline"><input type="checkbox" checked={lembrar} onChange={(e) => setLembrar(e.target.checked)} />
              Lembrar neste dispositivo por 30 dias</label>
            <p className="muted" style={{ fontSize: 12 }}>Só em aparelho seu: por 30 dias o app abre direto, sem senha, código nem bloqueio por inatividade.</p>
            <button className="primary" disabled={busy}>Verificar</button>
            <button type="button" onClick={() => supabase.auth.signOut()}>Cancelar</button>
          </form>
        )}
        {error && <p className="err">{error}</p>}
      </div>
    </div>
  )
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

  async function desbloquear(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null)
    const { data: factors } = await supabase.auth.mfa.listFactors()
    const totp = factors?.totp.find((f) => f.status === 'verified')
    if (!totp) { setBusy(false); return supabase.auth.signOut() }
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
        <form onSubmit={desbloquear} className="auth">
          <input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" placeholder="Código de 6 dígitos"
            value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
          <button className="primary" disabled={busy}>Desbloquear</button>
          <button type="button" onClick={() => supabase.auth.signOut()}>Sair da conta</button>
        </form>
        {error && <p className="err">{error}</p>}
      </div>
    </div>
  )
}
