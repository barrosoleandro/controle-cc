import { useEffect, useState } from 'react'
import { DEVICE_EVENT, deleteDevice, deviceState, revokeDevice, saveThisDevice, signOutOthers, syncDevice } from '../lib/device'
import { installedApp, keepStorage, rememberHere, trustUntil, trustedDevice } from '../lib/trust'
import { SIGNOUT_REASON, type Device, type SignoutReason } from '../domain/device'

const quando = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—')
const ios = () => /iPhone|iPad/.test(navigator.userAgent)

function situacao(d: Device): { text: string; cls: string } {
  if (d.revoked_at) return { text: `revogado em ${quando(d.revoked_at)}`, cls: 'neg' }
  if (d.trusted_until && Date.parse(d.trusted_until) > Date.now()) return { text: `lembrado até ${quando(d.trusted_until)}`, cls: 'pos' }
  return { text: 'não lembrado: pede login ao entrar', cls: 'muted' }
}

/**
 * The devices that use the account: which ones are remembered (open without the code), when each
 * was last seen and why it last had to sign in. Another device can be revoked from here; it is
 * signed out the next time it opens the app. "Sair dos outros" ends their sessions on the server.
 */
export function Devices() {
  const [st, setSt] = useState(deviceState)
  const [busy, setBusy] = useState(!deviceState())
  const [erro, setErro] = useState<string | null>(null)
  const [persisted, setPersisted] = useState<boolean | null>(null)
  const [, setTick] = useState(0) // re-render after a local trust change

  useEffect(() => {
    const refresh = () => { setSt(deviceState()); setBusy(false) }
    window.addEventListener(DEVICE_EVENT, refresh)
    if (!deviceState()) syncDevice().then(refresh)
    navigator.storage?.persisted?.().then(setPersisted, () => setPersisted(null))
    return () => window.removeEventListener(DEVICE_EVENT, refresh)
  }, [])
  const run = (f: () => Promise<unknown>) => { setErro(null); f().catch((e) => setErro((e as Error).message)) }

  if (busy) return <div className="card muted">Carregando os aparelhos…</div>
  if (!st) return <div className="card"><h3>Aparelhos</h3>
    <p className="warn">Rode <code>supabase/migrations/006_devices.sql</code> e <code>008_device_trust.sql</code> no SQL Editor do Supabase para ver e controlar os aparelhos.</p></div>

  const { device, devices } = st
  const migrated = devices.some((d) => d.trusted_until !== undefined)
  const lembrado = trustedDevice()
  const toggle = (on: boolean) => { rememberHere(on); setTick((n) => n + 1); run(async () => { await syncDevice(); if (on) setPersisted(await keepStorage()) }) }
  const outros = devices.filter((d) => d.id !== device.id)

  return <>
    <div className="card">
      <h3>Este aparelho</h3>
      <div className="form">
        <label>Nome
          <input key={device.id} defaultValue={device.name}
            onBlur={(e) => { const name = e.target.value.trim(); if (name && name !== device.name) run(() => saveThisDevice({ name })) }} />
        </label>
      </div>
      <p className={lembrado ? 'pos' : 'muted'} style={{ marginTop: 8 }}>
        {lembrado ? `✔ Lembrado: abre sem login até ${new Date(trustUntil()).toLocaleDateString('pt-BR')} — e cada uso empurra a data 30 dias para frente.` : 'Não lembrado: pede login ao entrar e trava após 15 minutos parado.'}
      </p>
      <div className="row">
        {lembrado ? <button onClick={() => toggle(false)}>Esquecer este aparelho</button> : <button className="primary" onClick={() => toggle(true)}>Lembrar este aparelho</button>}
      </div>
      <ul className="muted" style={{ fontSize: 13, margin: '10px 0 0 18px' }}>
        <li>Último login aqui: {quando(device.last_signin_at)}{device.last_signout ? ` — motivo: ${SIGNOUT_REASON[device.last_signout as SignoutReason] ?? device.last_signout}` : ''}</li>
        <li>Armazenamento persistente: {persisted === null ? 'o navegador não informa' : persisted ? 'sim (o navegador não apaga o login para liberar espaço)' : 'não'}</li>
        <li>Instalado como app: {installedApp() ? 'sim' : 'não'}</li>
      </ul>
      {ios() && !installedApp() && <p className="warn" style={{ marginTop: 8 }}>
        No iPhone, o Safari apaga os dados do site — inclusive o login — depois de 7 dias sem abri-lo. Para não pedir o login de novo,
        adicione o app à Tela de Início (Compartilhar → Adicionar à Tela de Início) e abra sempre por lá.</p>}
      {!migrated && <p className="warn" style={{ marginTop: 8 }}>Rode <code>supabase/migrations/008_device_trust.sql</code> no SQL Editor do Supabase:
        sem ela, o “lembrar” fica só neste navegador e os outros aparelhos não podem ser revogados daqui.</p>}
    </div>

    <div className="card" style={{ gridColumn: '1/-1' }}>
      <h3>Todos os aparelhos</h3>
      <div className="scroll"><table>
        <thead><tr><th>Aparelho</th><th>Situação</th><th className="hide-sm">Visto em</th><th className="hide-sm">Último login e motivo</th><th /></tr></thead>
        <tbody>{devices.map((d) => {
          const s = situacao(d)
          return <tr key={d.id}>
            <td>{d.name}{d.id === device.id && <strong> · este</strong>}<div className="muted" style={{ fontSize: 12 }}>{[d.kind, d.hardware.os].filter(Boolean).join(' · ')}</div></td>
            <td className={s.cls}>{s.text}</td>
            <td className="hide-sm">{quando(d.last_seen_at)}</td>
            <td className="hide-sm" style={{ fontSize: 13 }}>{quando(d.last_signin_at)}{d.last_signout && <div className="muted">{SIGNOUT_REASON[d.last_signout as SignoutReason] ?? d.last_signout}</div>}</td>
            <td style={{ whiteSpace: 'nowrap' }}>{d.id !== device.id && <>
              {migrated && !d.revoked_at && <button onClick={() => confirm(`Revogar "${d.name}"? Ele vai pedir login completo na próxima vez que abrir o app.`) && run(() => revokeDevice(d.id))}>Revogar</button>}
              <button className="link" title="Remover da lista" aria-label={`Remover ${d.name}`}
                onClick={() => confirm(`Remover "${d.name}" da lista? As configurações dele (IA local) serão apagadas.`) && run(() => deleteDevice(d.id))}>✕</button>
            </>}</td>
          </tr>
        })}</tbody>
      </table></div>
      {outros.length > 0 && <div className="row" style={{ marginTop: 10 }}>
        <button onClick={() => confirm('Encerrar agora a sessão de todos os outros aparelhos? Eles vão pedir login completo.') && run(signOutOthers)}>Sair de todos os outros aparelhos</button>
      </div>}
      {erro && <p className="err">{erro}</p>}
    </div>
  </>
}
