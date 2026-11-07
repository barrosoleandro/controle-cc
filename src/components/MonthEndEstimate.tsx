import { useEffect, useMemo, useState } from 'react'
import type { Ctx } from '../App'
import { currentMonth, today, useFmt } from '../lib/hooks'
import { ask, loadOllama, OLLAMA_EVENT, ollamaReady } from '../lib/ollama'
import { useRecurring } from '../lib/recurring'
import { lastCompleteMonths } from '../domain/analytics'
import { billEffective, lastDayOf } from '../domain/forecast'
import { buildMonthPlan, recurringExpectations, steadyIncomes, type PlanTx } from '../domain/monthPlan'
import { combineMonthEnd, monthEndFacts } from '../domain/monthEnd'
import { monthEndPrompt, parseMonthEndAnswer } from '../domain/localAi'
import { monthLabel } from '../lib/format'

const CACHE = 'monthEndAi' // last answer per input: reopening the screen with the same numbers does not ask again
const DEBOUNCE = 1500 // a burst of edits (categories, marks) asks once

function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}
function readCache(sig: string): Map<string, number> | null {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE) ?? 'null') as { sig: string; est: [string, number][] } | null
    return c?.sig === sig ? new Map(c.est) : null
  } catch { return null }
}
function writeCache(sig: string, est: Map<string, number>) {
  try { localStorage.setItem(CACHE, JSON.stringify({ sig, est: [...est] })) } catch { /* storage blocked: asks again next visit */ }
}

/**
 * KPI box on Lançamentos: the result expected at the end of the current month for the ticked
 * accounts — real so far + what is still expected. The baseline is the month plan (as in
 * Previsão); with the local model on, it re-estimates each category from 12 months of history,
 * and runs again whenever the inputs change. Nothing leaves the computer.
 */
export function MonthEndEstimate({ ctx, txs, balance }: { ctx: Ctx; txs: PlanTx[]; balance: number }) {
  const fmt = useFmt(ctx)
  const { data, fx } = ctx
  const month = currentMonth()
  const avgMonths = useMemo(() => lastCompleteMonths(new Date(), 3), [])
  const histMonths = useMemo(() => lastCompleteMonths(new Date(), 12), [])

  const catById = useMemo(() => new Map(data.categories.map((c) => [c.id, c])), [data.categories])
  const lines = data.settings.dashboard?.manualLines
  const manual = useMemo(() => (lines ?? []).filter((l) => l.month === month).map((l) => {
    const c = catById.get(l.category_id)
    const kind = c?.kind ?? 'expense'
    const v = fx.convert(Math.abs(l.amount), l.currency, ctx.currency, l.date)
    return { month: l.month, kind, categoryName: c?.name ?? 'Outros', value: kind === 'income' ? v : -v, merchant: l.merchant }
  }), [lines, catById, fx, ctx.currency, month])
  const { isBill, marks } = useRecurring(ctx)
  const steady = useMemo(() => steadyIncomes(txs, avgMonths), [txs, avgMonths])
  const recurring = useMemo(() => recurringExpectations(txs,
    (m, kind) => (kind === 'expense' ? isBill({ merchant: m }) : billEffective(m, marks, steady.has(m))), avgMonths), [txs, isBill, marks, steady, avgMonths])
  const cats = useMemo(() => monthEndFacts(buildMonthPlan(txs, manual, month, avgMonths, recurring), txs, histMonths),
    [txs, manual, month, avgMonths, recurring, histMonths])

  const [cfg, setCfg] = useState(loadOllama)
  useEffect(() => {
    const refresh = () => setCfg(loadOllama())
    window.addEventListener(OLLAMA_EVENT, refresh)
    return () => window.removeEventListener(OLLAMA_EVENT, refresh)
  }, [])
  const ready = ollamaReady(cfg)

  const day = Number(today().slice(8, 10))
  const facts = useMemo(() => ({ moeda: ctx.currency, mes: month, dia: day, diasNoMes: Number(lastDayOf(month).slice(8, 10)), meses: histMonths, categorias: cats }),
    [ctx.currency, month, day, histMonths, cats])
  const sig = useMemo(() => hash(`${cfg.model}|${JSON.stringify(facts)}`), [cfg.model, facts])

  // The answer always carries the signature it was made for: a stale one is never shown as current.
  const [ai, setAi] = useState<{ sig: string; est: Map<string, number> } | null>(null)
  const [busy, setBusy] = useState(false)
  const [erro, setErro] = useState<{ sig: string; msg: string } | null>(null)
  const current = useMemo(() => (ai?.sig === sig ? ai.est : readCache(sig)), [ai, sig])

  // One call in flight at a time; when it ends, a change that came meanwhile starts the next one.
  useEffect(() => {
    if (!ready || busy || !cats.length || current || erro?.sig === sig) return
    const timer = setTimeout(async () => {
      setBusy(true)
      try {
        const { system, prompt } = monthEndPrompt(facts)
        const est = parseMonthEndAnswer(await ask(cfg, prompt, { system, json: true, temperature: 0 }), cats.map((c) => c.key))
        writeCache(sig, est)
        setAi({ sig, est })
      } catch (e) {
        setErro({ sig, msg: (e as Error).message })
      } finally { setBusy(false) }
    }, DEBOUNCE)
    return () => clearTimeout(timer)
  }, [ready, busy, sig, current, erro?.sig, cats, facts, cfg])

  const est = useMemo(() => combineMonthEnd(cats, current), [cats, current])
  const fonte = !ready ? 'média dos últimos 3 meses · ligue a IA local em Ajustes para usar o histórico'
    : busy || (!current && erro?.sig !== sig) ? `recalculando com ${cfg.model}… (mostrando a média)`
      : erro?.sig === sig ? 'média dos últimos 3 meses · a IA local falhou'
        : `IA local (${cfg.model}) sobre 12 meses de histórico · nada sai deste computador`

  return (
    <div className="kpi" title={[
      `Receitas previstas: ${fmt(est.income)}`, `Despesas previstas: ${fmt(est.expense)}`,
      `Resultado real até hoje: ${fmt(est.realResultado)}`, `Ainda por vir: ${fmt(est.remaining)}`,
      erro?.sig === sig ? `Erro da IA local: ${erro.msg}` : '',
    ].filter(Boolean).join('\n')}>
      <div className="l">Estimativa fim de {monthLabel(month)} · resultado</div>
      <div className={`v ${est.resultado < 0 ? 'neg' : ''}`}>{fmt(est.resultado)}</div>
      <div className="sub">Saldo previsto {fmt(balance + est.remaining)} · real até hoje {fmt(est.realResultado)}</div>
      <div className="sub" style={{ fontSize: 11 }}>{fonte}</div>
    </div>
  )
}
