import type { Ctx } from '../App'
import type { PlanTx } from '../domain/monthPlan'
import { monthLabel } from '../lib/format'
import { useFmt } from '../lib/hooks'
import { useMonthEnd } from '../lib/monthEnd'
import { Stat } from './Page'

/** Lançamentos: the end-of-month estimate as a box next to the balance. */
export function MonthEndEstimate({ ctx, txs, balance }: { ctx: Ctx; txs: PlanTx[]; balance: number }) {
  const fmt = useFmt(ctx)
  const { est, month, saldo, fonte, title } = useMonthEnd(ctx, txs, balance)
  return (
    <div className="kpi" title={title}>
      <div className="l">Estimativa fim de {monthLabel(month)} · resultado</div>
      <div className={`v ${est.resultado < 0 ? 'neg' : ''}`}>{fmt(est.resultado)}</div>
      <div className="sub">Saldo previsto {fmt(saldo)} · real até hoje {fmt(est.realResultado)}</div>
      <div className="sub" style={{ fontSize: 11 }}>{fonte}</div>
    </div>
  )
}

/** Painel: the same estimate, as one of the month stats. */
export function MonthEndStat({ ctx, txs, balance }: { ctx: Ctx; txs: PlanTx[]; balance: number }) {
  const fmt = useFmt(ctx)
  const { est, month, saldo, fonte, title } = useMonthEnd(ctx, txs, balance)
  return (
    <div title={title} style={{ display: 'contents' }}>
      <Stat tone="neutral" icon="resultado" label={`Resultado previsto · ${monthLabel(month)}`}
        value={<span className={est.resultado >= 0 ? 'pos' : 'neg'}>{fmt(est.resultado)}</span>}
        sub={<>Saldo previsto {fmt(saldo)} · real até hoje {fmt(est.realResultado)}<br /><span style={{ fontSize: 11 }}>{fonte}</span></>} />
    </div>
  )
}
