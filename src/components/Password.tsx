import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

/**
 * Sets or changes the password from a device already signed in with the second factor (aal2),
 * without the reset e-mail. Lets a new device sign in when the e-mail is out of reach.
 * If Supabase has "Secure password change" on, it asks for a nonce sent by e-mail: the message says so.
 */
export function Password() {
  const [nova, setNova] = useState('')
  const [confirma, setConfirma] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [aal2, setAal2] = useState<boolean | null>(null)
  useEffect(() => { supabase.auth.mfa.getAuthenticatorAssuranceLevel().then(({ data }) => setAal2(data?.currentLevel === 'aal2'), () => setAal2(false)) }, [])

  async function salvar(e: React.FormEvent) {
    e.preventDefault(); setMsg(null)
    if (nova !== confirma) return setMsg({ ok: false, text: 'As senhas não conferem.' })
    setBusy(true)
    const { error } = await supabase.auth.updateUser({ password: nova })
    setBusy(false); setNova(''); setConfirma('')
    if (!error) return setMsg({ ok: true, text: 'Senha salva. Use-a para entrar em outro aparelho, junto com o código do autenticador ou a biometria.' })
    const reauth = /reauth|nonce/i.test(error.message)
    setMsg({ ok: false, text: reauth
      ? 'O Supabase exige confirmação por e-mail para trocar a senha. Desligue "Secure password change" em Authentication → Providers → Email e tente de novo.'
      : `Não foi possível salvar a senha: ${error.message}` })
  }

  // Quem entrou pelo QR code (acesso pontual, aal1) não troca a senha da conta.
  if (aal2 === false) return <div className="card"><h3>Senha</h3>
    <p className="muted" style={{ fontSize: 13 }}>Num acesso pontual pelo QR code, a senha só pode ser trocada no aparelho que aprovou.</p></div>
  return <div className="card">
    <h3>Senha</h3>
    <p className="muted" style={{ fontSize: 13 }}>Defina ou troque a senha daqui, sem e-mail. Depois dela, o login continua pedindo o código do autenticador ou a biometria.</p>
    <form onSubmit={salvar} className="auth">
      <input type="password" autoComplete="new-password" placeholder="Senha nova (mín. 8)" minLength={8} value={nova} onChange={(e) => setNova(e.target.value)} required />
      <input type="password" autoComplete="new-password" placeholder="Repita a senha nova" minLength={8} value={confirma} onChange={(e) => setConfirma(e.target.value)} required />
      <button className="primary" disabled={busy}>{busy ? 'Salvando…' : 'Salvar senha'}</button>
    </form>
    {msg && <p className={msg.ok ? 'pos' : 'err'}>{msg.ok ? '✔ ' : ''}{msg.text}</p>}
  </div>
}
