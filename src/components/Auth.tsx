import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

type Step = 'loading' | 'login' | 'enroll' | 'verify' | 'ok'

/**
 * Email/password + mandatory TOTP. Data is only readable with an aal2 session (enforced by RLS),
 * so this screen is a convenience — the security boundary is the database.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const [step, setStep] = useState<Step>('loading')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [qr, setQr] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [factorId, setFactorId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function evaluate() {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return setStep('login')
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (aal?.currentLevel === 'aal2') return setStep('ok')
    const { data: factors } = await supabase.auth.mfa.listFactors()
    const totp = factors?.totp.find((f) => f.status === 'verified')
    if (totp) { setFactorId(totp.id); return setStep('verify') }
    // Clean up half-finished enrolments, then enrol a new authenticator.
    for (const f of factors?.all ?? []) if (f.status !== 'verified') await supabase.auth.mfa.unenroll({ factorId: f.id })
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Controle CC' })
    if (error) { setError(error.message); return setStep('login') }
    setFactorId(data.id); setQr(data.totp.qr_code); setSecret(data.totp.secret)
    setStep('enroll')
  }

  useEffect(() => {
    evaluate()
    const { data } = supabase.auth.onAuthStateChange((e) => { if (e === 'SIGNED_OUT') setStep('login') })
    return () => data.subscription.unsubscribe()
  }, [])

  async function login(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setPassword('')
    setBusy(false)
    if (error) return setError('Login failed.') // generic message: don't reveal which part was wrong
    await evaluate()
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault(); if (!factorId) return
    setBusy(true); setError(null)
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.trim() })
    setBusy(false); setCode('')
    if (error) return setError('Invalid code.')
    setStep('ok')
  }

  if (step === 'ok') return <>{children}</>
  return (
    <div className="center">
      <div className="card auth">
        <h3>Controle CC</h3>
        {step === 'loading' && <p className="muted">Loading…</p>}
        {step === 'login' && (
          <form onSubmit={login} className="auth">
            <input type="email" autoComplete="username" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <input type="password" autoComplete="current-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            <button className="primary" disabled={busy}>Sign in</button>
          </form>
        )}
        {(step === 'enroll' || step === 'verify') && (
          <form onSubmit={verify} className="auth">
            {step === 'enroll' && <>
              <p>Two-factor authentication is mandatory. Scan with Google Authenticator / Microsoft Authenticator / 1Password:</p>
              {qr && <img src={qr} alt="TOTP QR code" style={{ width: 200, background: '#fff', justifySelf: 'center' }} />}
              <p className="muted" style={{ wordBreak: 'break-all', fontSize: 12 }}>Manual key: {secret}</p>
            </>}
            <input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} required />
            <button className="primary" disabled={busy}>Verify</button>
            <button type="button" onClick={() => supabase.auth.signOut()}>Cancel</button>
          </form>
        )}
        {error && <p className="err">{error}</p>}
      </div>
    </div>
  )
}
