import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { noteSignedIn, noteSignedOut, setTrust, signOutWith, trustUntil, trustedDevice } from '../lib/trust'
import { AccessApprove, AccessRequest } from './Access'
import { APPROVE_PARAM } from '../domain/access'

type Step = 'loading' | 'login' | 'pedir' | 'code' | 'reset' | 'newpass' | 'ok'
type Metodo = 'senha' | 'email'

export const APP_NAME = 'Finanças Pessoais'
const RECOVERY_PARAM = 'recuperar' // marks the return from the reset e-mail link

/**
 * Entrada por senha ou por código enviado no e-mail, sem segundo fator (decisão do dono do app:
 * o Authenticator deixou de ser exigido). O RLS no banco garante que cada um só vê as próprias linhas.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const [step, setStep] = useState<Step>('loading')
  const [metodo, setMetodo] = useState<Metodo>('senha')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [emailCode, setEmailCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [lembrar, setLembrar] = useState(true)
  // Back from the reset link: the link signs in; the new password is asked right after.
  const [recuperando] = useState(() => new URLSearchParams(window.location.search).has(RECOVERY_PARAM))
  const [novaSenha, setNovaSenha] = useState('')
  const [confirmaSenha, setConfirmaSenha] = useState('')

  async function evaluate() {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return setStep('login')
    // 30 dias sem abrir o app neste aparelho (cada uso renova): pede o login de novo.
    if (trustUntil() && !trustedDevice()) { await signOutWith('expirou'); return }
    setStep(recuperando ? 'newpass' : 'ok')
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
    noteSignedIn(lembrar)
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
    noteSignedIn(lembrar)
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

  const lembrarBox = <>
    <label className="inline"><input type="checkbox" checked={lembrar} onChange={(e) => setLembrar(e.target.checked)} />
      Lembrar neste aparelho</label>
    <p className="muted" style={{ fontSize: 12 }}>Só em aparelho seu: o app abre direto, sem login nem bloqueio por inatividade, enquanto for usado ao menos uma vez a cada 30 dias. Dá para revogar em Ajustes → Aparelhos.</p>
  </>

  if (step === 'ok') return <>{children}<ApproveFromLink /></>
  return (
    <div className="center">
      <div className="card auth">
        <h3>{APP_NAME}</h3>
        {step === 'loading' && <p className="muted">Carregando…</p>}

        {step === 'pedir' && <AccessRequest onDone={() => setStep('ok')} onCancel={() => setStep('login')} />}

        {step === 'login' && <>
          <button type="button" onClick={() => { setStep('pedir'); setError(null); setInfo(null) }}>Pedir acesso pelo celular (QR code)</button>
          <div className="row">
            <button className={metodo === 'senha' ? 'active' : ''} onClick={() => { setMetodo('senha'); setError(null) }}>Senha</button>
            <button className={metodo === 'email' ? 'active' : ''} onClick={() => { setMetodo('email'); setError(null) }}>Código por e-mail</button>
          </div>
          {metodo === 'senha' ? (
            <form onSubmit={entrarComSenha} className="auth">
              <input type="email" name="email" id="email" autoComplete="username" placeholder="E-mail" value={email} onChange={(e) => setEmail(e.target.value)} required />
              <input type="password" name="password" id="password" autoComplete="current-password" placeholder="Senha" value={password} onChange={(e) => setPassword(e.target.value)} required />
              {lembrarBox}
              <button type="submit" className="primary" disabled={busy}>Entrar</button>
              <button type="button" className="link" onClick={() => { setStep('reset'); setError(null); setInfo(null) }}>Esqueci minha senha</button>
            </form>
          ) : (
            <form onSubmit={pedirCodigo} className="auth">
              <input type="email" autoComplete="username" placeholder="E-mail" value={email} onChange={(e) => setEmail(e.target.value)} required />
              <button className="primary" disabled={busy}>Enviar código</button>
              <p className="muted" style={{ fontSize: 12 }}>Sem senha: você recebe um código no e-mail.</p>
            </form>
          )}
        </>}

        {step === 'code' && (
          <form onSubmit={entrarComCodigo} className="auth">
            {info && <p className="muted">{info}</p>}
            <input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" placeholder="Código do e-mail" value={emailCode} onChange={(e) => setEmailCode(e.target.value)} required />
            {lembrarBox}
            <button className="primary" disabled={busy}>Confirmar</button>
            <button type="button" onClick={() => { setStep('login'); setError(null); setInfo(null) }}>Voltar</button>
          </form>
        )}

        {step === 'reset' && (
          <form onSubmit={pedirReset} className="auth">
            <p className="muted">Enviamos um link para o seu e-mail. Depois de abrir o link, o app pede a senha nova.</p>
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
        {error && <p className="err">{error}</p>}
      </div>
    </div>
  )
}

/** O app foi aberto pelo QR code de um pedido (?aprovar=…), já logado: abre a aprovação. */
function ApproveFromLink() {
  const [code, setCode] = useState(() => new URLSearchParams(window.location.search).get(APPROVE_PARAM))
  const fechar = () => { window.history.replaceState(null, '', window.location.pathname); setCode(null) }
  return code ? <AccessApprove initialCode={code} onClose={fechar} /> : null
}

/**
 * Tela de bloqueio por inatividade (só em aparelho não lembrado). A sessão é mantida: voltar custa
 * a senha da conta. Sem a senha, "Sair da conta" e entrar de novo pelo código do e-mail.
 * Depois de mais tempo parado, quem desloga de verdade é o App.
 */
export function ReauthLock({ onUnlock }: { onUnlock: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function desbloquear(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user?.email) { setBusy(false); return signOutWith('servidor') }
    const { error } = await supabase.auth.signInWithPassword({ email: user.email, password })
    setBusy(false); setPassword('')
    if (error) return setError('Senha incorreta.')
    onUnlock()
  }

  return (
    <div className="lock">
      <div className="card auth">
        <h3>Tela bloqueada</h3>
        <p className="muted">Você ficou um tempo sem usar o app. Digite a senha para voltar.</p>
        <form onSubmit={desbloquear} className="auth">
          <input type="password" autoComplete="current-password" placeholder="Senha"
            value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
          <button className="primary" disabled={busy}>Desbloquear</button>
          <button type="button" onClick={() => signOutWith('manual')}>Sair da conta</button>
        </form>
        {error && <p className="err">{error}</p>}
      </div>
    </div>
  )
}
