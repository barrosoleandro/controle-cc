// "Lembrar neste dispositivo": a sessão (já em aal2) fica de pé por 30 dias, sem trava
// por inatividade. O RLS continua exigindo aal2; só não se pede o login de novo.
const TRUST_KEY = 'trustedUntil'
const TRUST_MS = 30 * 86400000

export function trustUntil(): number {
  try { return Number(localStorage.getItem(TRUST_KEY) ?? 0) } catch { return 0 }
}
export const trustedDevice = () => trustUntil() > Date.now()
export function setTrust(on: boolean) {
  try {
    if (on) localStorage.setItem(TRUST_KEY, String(Date.now() + TRUST_MS))
    else localStorage.removeItem(TRUST_KEY)
  } catch { /* storage bloqueado: segue sem lembrar */ }
}
