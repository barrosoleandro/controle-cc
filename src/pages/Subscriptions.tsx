import type { Ctx } from '../App'
import { subscriptionAlerts } from '../domain/subscriptions'
import { today, useFmt, useSubscriptions } from '../lib/hooks'

export function Subscriptions({ ctx }: { ctx: Ctx }) {
  const fmt = useFmt(ctx)
  const subs = useSubscriptions(ctx)
  const alerts = subscriptionAlerts(subs, today(), fmt)
  const active = subs.filter((s) => s.status !== 'possibly_cancelled')
  const total = active.reduce((s, x) => s + x.monthlyCost, 0)
  return (
    <div className="grid">
      <div className="card" style={{ gridColumn: '1/-1' }}>
        <h3>Recurring charges — {fmt(total)}/month · {fmt(total * 12)}/year</h3>
        <p className="muted">Detected automatically: same merchant, regular interval, stable amount. Includes rent, loans and insurance, not only streaming.</p>
        <div className="scroll"><table>
          <thead><tr><th>Merchant</th><th>Cadence</th><th className="num">Last</th><th className="num">Per month</th><th className="hide-sm">Since</th><th>Next</th><th>Status</th></tr></thead>
          <tbody>{subs.map((s) => (
            <tr key={s.merchant} className={s.status === 'possibly_cancelled' ? 'muted' : ''}>
              <td>{s.merchant}</td><td>{s.cadence}</td>
              <td className="num">{fmt(s.lastAmount)}{s.priceChangePct > 0.05 && <span className="neg"> ▲{(s.priceChangePct * 100).toFixed(0)}%</span>}</td>
              <td className="num">{fmt(s.monthlyCost)}</td><td className="hide-sm">{s.firstDate}</td><td>{s.nextDate}</td>
              <td>{s.status === 'new' ? 'new' : s.status === 'possibly_cancelled' ? 'stopped?' : 'active'}</td>
            </tr>))}</tbody>
        </table></div>
      </div>
      <div className="card"><h3>Alerts</h3>
        {alerts.length ? alerts.map((a) => <div key={a.key} className={`alert ${a.level}`}>{a.level === 'warn' ? '⚠ ' : 'ℹ '}{a.text}</div>) : <p className="muted">No alerts.</p>}
      </div>
    </div>
  )
}
