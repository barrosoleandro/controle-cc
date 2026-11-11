import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Ctx } from '../App'
import { monthEnd } from '../domain/monthEnd'
import { nextMonth } from '../domain/monthPlan'
import { monthEndPrompt, parseMonthEndAnswer, type MonthEndFacts } from '../domain/localAi'
import { findSalaryCategory } from '../domain/budget'
import { isTithe } from '../domain/categorize'
import { monthLabel } from '../lib/format'
import { currentMonth, today, useBalances, useFmt } from '../lib/hooks'
import { useMonthPlans } from '../lib/plan'
import { ask, loadOllama, OLLAMA_EVENT, ollamaReady } from '../lib/ollama'
import { Stat } from './Page'
import { round2 } from '../domain/util'

/** The local model's last estimate, kept per computer: the same numbers on screen do not ask again. */
const CACHE = 'monthEndAi'
interface Cached { sig: string; falta: [string, number][]; comentario: string; ignoradas: string[]; model: string; at: string }
const readCache = (): Cached | null => { try { return JSON.parse(localStorage.getItem(CACHE) ?? 'null') as Cached | null } catch { return null } }
const writeCache = (c: Cached) => { try { localStorage.setItem(CACHE, JSON.stringify(c)) } catch { /* storage blocked: kept for this visit only */ } }

/**
 * The current month at its end, for the accounts in scope: real so far plus what is still
 * expected, and the balance it leaves. Money comes in only through BCP. The estimate of what is
 * still to come is the local model's when it has answered, or the app's (the same as Previsão).
 * `inScope`: the accounts ticked on the page; a card counts with the account that pays it.
 */
export function MonthEndBox({ ctx, inScope }: { ctx: Ctx; inScope: (accountId: string) => boolean }) {
  const fmt = useFmt(ctx)
  const { data } = ctx
  const cur = currentMonth()
  const months = useMemo(() => [cur], [cur])
  const bcp = useMemo(() => new Set(data.accounts.filter((a) => a.bank === 'BCP').map((a) => a.id)), [data.accounts])
  const incomeFrom = useCallback((id: string) => bcp.has(id), [bcp])
  const salary = findSalaryCategory(data.categories)?.name
  const { txs, plans, avgMonths } = useMonthPlans(ctx, inScope, months, { incomeFrom, salary })
  const plan = plans[0]
  const bcpIn = data.accounts.some((a) => bcp.has(a.id) && inScope(a.id))
  const balances = useBalances(ctx)
  const saldoHoje = balances.filter((b) => inScope(b.account.id)).reduce((s, b) => s + b.display, 0)
  const nomes = data.accounts.filter((a) => a.type !== 'card' && inScope(a.id)).map((a) => a.name)

  // Next month's salary, paid at the end of this one, is left out: not in this month's result, and
  // taken out of today's balance once it is in.
  const next = nextMonth(cur)
  const salarioSeguinte = salary ? txs.filter((t) => t.kind === 'income' && t.categoryName === salary && t.month === next && t.booking_date.slice(0, 7) === cur).reduce((s, t) => s + t.value, 0) : 0

  const day = Number(today().slice(8, 10))
  const [y, m] = cur.split('-').map(Number)
  const diasNoMes = new Date(y, m, 0).getDate()
  // Tithe stays at the app's figure: it is not handed to the model.
  const facts: MonthEndFacts = useMemo(() => ({
    moeda: ctx.currency, mes: monthLabel(cur), dia: day, diasNoMes, mediaDe: monthLabel(avgMonths[0]), mediaAte: monthLabel(avgMonths.at(-1)!),
    categorias: [...plan.income, ...plan.expense].filter((r) => !isTithe(r.name)).map((r) => ({
      tipo: r.kind === 'income' ? 'receita' : 'despesa', nome: r.name,
      media: round(r.media), realizado: round(r.realizado), manual: round(r.manual), recorrentesPendentes: round(r.recorrente), estimativaApp: round(r.falta),
    })),
  }), [plan, ctx.currency, cur, day, diasNoMes, avgMonths])
  const sig = useMemo(() => JSON.stringify([facts.dia, facts.moeda, facts.categorias.map((c) => [c.tipo, c.nome, c.media, c.realizado, c.manual, c.recorrentesPendentes, c.estimativaApp])]), [facts])

  const [cfg, setCfg] = useState(loadOllama)
  useEffect(() => {
    const refresh = () => setCfg(loadOllama())
    window.addEventListener('focus', refresh)
    window.addEventListener(OLLAMA_EVENT, refresh)
    return () => { window.removeEventListener('focus', refresh); window.removeEventListener(OLLAMA_EVENT, refresh) }
  }, [])
  const ready = ollamaReady(cfg)
  const [ai, setAi] = useState<Cached | null>(readCache)
  const [busy, setBusy] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const mine = ai?.sig === sig ? ai : null
  const [fonte, setFonte] = useState<'ia' | 'app'>('ia')
  const useAi = fonte === 'ia' && !!mine

  async function estimar() {
    const c = loadOllama()
    setCfg(c)
    if (!ollamaReady(c)) { setErro('Ative e configure o endereço e o modelo em Ajustes → IA local.'); return }
    if (!facts.categorias.length) { setErro('Nada neste mês nem na média das contas marcadas para estimar.'); return }
    const asked = sig, list = facts.categorias
    setBusy(true); setErro(null)
    try {
      const { system, prompt } = monthEndPrompt(facts)
      const r = parseMonthEndAnswer(await ask(c, prompt, { system, json: true, temperature: 0 }), list)
      const out: Cached = { sig: asked, falta: [...r.falta], comentario: r.comentario, ignoradas: r.ignoradas, model: c.model, at: new Date().toISOString() }
      writeCache(out)
      setAi(out)
      setFonte('ia')
    } catch (e) { setErro((e as Error).message) } finally { setBusy(false) }
  }
  // One run per visit when the model is on and these numbers have no estimate yet.
  const ranRef = useRef(false)
  useEffect(() => {
    if (ranRef.current || !ready || mine || !facts.categorias.length) return
    ranRef.current = true
    void estimar()
  }, [ready, mine, facts]) // eslint-disable-line react-hooks/exhaustive-deps

  // What you planned per category for the month, saved in your account: it wins over the estimates.
  const saved = data.settings.dashboard?.monthEndPlan?.[cur]
  const planned = useMemo(() => (saved ? new Map(Object.entries(saved.falta).map(([k, v]) =>
    [k, saved.currency === ctx.currency ? v : round(ctx.fx.convert(v, saved.currency, ctx.currency, today()))])) : undefined), [saved, ctx.currency, ctx.fx])
  async function savePlan(falta: Map<string, number>) {
    setErro(null)
    const all = { ...data.settings.dashboard?.monthEndPlan }
    if (falta.size) all[cur] = { currency: ctx.currency, falta: Object.fromEntries(falta) }
    else delete all[cur]
    try { await ctx.patchSettings({ dashboard: { ...data.settings.dashboard, monthEndPlan: all } }) }
    catch (err) { setErro(`Não foi possível salvar o planejado: ${(err as Error).message}`) }
  }
  const setPlanned = (key: string, v: number | null) => {
    const next = new Map(planned)
    if (v === null) next.delete(key); else next.set(key, round(Math.max(0, v)))
    return savePlan(next)
  }

  const aiMap = useMemo(() => (mine ? new Map(mine.falta) : undefined), [mine])
  const withAi = useMemo(() => (aiMap ? monthEnd(plan, saldoHoje, salarioSeguinte, aiMap) : null), [plan, saldoHoje, salarioSeguinte, aiMap])
  const e = useMemo(() => monthEnd(plan, saldoHoje, salarioSeguinte, useAi ? aiMap : undefined, planned), [plan, saldoHoje, salarioSeguinte, useAi, aiMap, planned])
  const nAjustes = e.rows.filter((r) => r.ajustado).length
  const sign = (v: number) => (v < 0 ? 'neg' : 'pos')
  const parts = (s: { real: number; estimado: number }) => `real ${fmt(s.real)} + estimativa ${fmt(s.estimado)}`

  return (
    <div className="card" style={{ gridColumn: '1/-1' }}>
      <div className="card-head">
        <h3>Fim de {monthLabel(cur)} — real + estimativa</h3>
        {withAi && <div className="seg" role="group" aria-label="Estimativa usada">
          <button className={useAi ? 'on' : ''} onClick={() => setFonte('ia')}>IA local</button>
          <button className={!useAi ? 'on' : ''} onClick={() => setFonte('app')}>App (média)</button>
        </div>}
      </div>
      <div className="stats">
        <Stat tone="neutral" icon="resultado" label="Resultado do mês" value={<span className={sign(e.resultado.total)}>{fmt(e.resultado.total)}</span>} sub={parts(e.resultado)} />
        <Stat tone="pos" icon="entrada" label={bcpIn ? 'Receitas (só BCP)' : 'Receitas'} value={<span className="pos">{fmt(e.receitas.total)}</span>}
          sub={bcpIn ? parts(e.receitas) : 'só entram pelo BCP: marque uma conta BCP para vê-las'} />
        <Stat tone="neg" icon="saida" label="Despesas" value={<span className="neg">{fmt(e.despesas.total)}</span>} sub={parts(e.despesas)} />
        <Stat tone="accent" icon="carteira" label="Saldo no fim do mês" value={<span className={e.saldoFim < 0 ? 'neg' : ''}>{fmt(e.saldoFim)}</span>}
          sub={`hoje ${fmt(e.saldoHoje)} ${e.receitas.estimado - e.despesas.estimado >= 0 ? '+' : '−'} ${fmt(Math.abs(e.receitas.estimado - e.despesas.estimado))} até o dia ${diasNoMes}`}>
          {e.salarioSeguinte > 0 && <div className="stat-sub">sem o salário de {monthLabel(next).split(' ')[0]} já creditado ({fmt(e.salarioSeguinte)})</div>}
        </Stat>
      </div>

      {nAjustes > 0 && <p className="muted" style={{ fontSize: 13, margin: '8px 0 0' }}>Inclui {nAjustes} categoria(s) com o planejado ajustado por você (veja e altere na tabela por categoria).</p>}
      <div className="row" style={{ marginTop: 12 }}>
        <button onClick={estimar} disabled={busy || !ready} title={ready ? 'Roda neste computador; nada é enviado para fora' : 'Configure em Ajustes → IA local'}>
          {busy ? 'Estimando…' : mine ? 'Estimar de novo com a IA local' : 'Estimar com a IA local'}</button>
        {ready
          ? <span className="muted" style={{ fontSize: 12 }}>{cfg.model} · nada sai deste computador{mine ? ` · estimativa de ${new Date(mine.at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}` : ''}</span>
          : <span className="muted" style={{ fontSize: 12 }}>IA local desligada — ligue em Ajustes → IA local; enquanto isso, a estimativa é a do app (média de 3 meses e recorrentes, como na Previsão)</span>}
      </div>
      {busy && <p className="muted">Um modelo local pode levar alguns minutos. Enquanto isso, os números acima são a estimativa do app.</p>}
      {erro && <p className="err" style={{ whiteSpace: 'pre-wrap' }}>{erro}</p>}
      {useAi && mine?.comentario && <div className="alert" style={{ display: 'block', marginTop: 8 }}>
        <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{mine.comentario}</p>
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>A IA propõe só quanto ainda falta em cada categoria; as somas e o saldo são feitos pelo app e podem ser comparados na tabela abaixo.
          {mine.ignoradas.length > 0 && ` Valor da IA descartado (fora do razoável) em: ${mine.ignoradas.join(', ')} — fica a estimativa do app.`}</p>
      </div>}

      <details style={{ marginTop: 8 }} open={nAjustes > 0 || undefined}>
        <summary className="muted" style={{ fontSize: 13 }}>{withAi ? 'Ver o que a IA estimou e ajustar o planejado, por categoria' : 'Ver e ajustar o planejado, por categoria'}</summary>
        <div className="row" style={{ margin: '8px 0' }}>
          {withAi && <button onClick={() => savePlan(new Map(withAi.rows.map((r) => [r.key, round(r.usado)])))}
            title="Grava o que a IA estimou como o seu planejado em todas as categorias; depois ajuste o que quiser">Usar a estimativa da IA no planejado</button>}
          {nAjustes > 0 && <button onClick={() => savePlan(new Map())}>Desfazer meus ajustes</button>}
          <span className="muted" style={{ fontSize: 12 }}>Planejado = quanto ainda falta entrar ou sair até o fim do mês (inclui as linhas manuais). Salvo na sua conta, vale só para {monthLabel(cur)}.</span>
        </div>
        <div className="scroll"><table>
          <thead><tr><th>Categoria</th><th className="num">Real</th><th className="num">Falta (app)</th>{withAi && <th className="num">Falta (IA)</th>}<th className="num">Planejado</th><th className="num">Fim do mês</th></tr></thead>
          <tbody>
            {(['income', 'expense'] as const).map((kind) => {
              const list = e.rows.filter((r) => r.kind === kind)
              if (!list.length) return null
              const ai = new Map(withAi?.rows.map((r) => [r.key, r.usado]))
              return [<tr key={kind} className="section"><th colSpan={withAi ? 6 : 5}>{kind === 'income' ? 'Receitas' : 'Despesas'}</th></tr>,
                ...list.map((r) => (
                  <tr key={r.key}><td>{r.name}</td><td className="num">{fmt(r.real)}</td>
                    <td className="num muted">{r.app ? fmt(r.app) : '·'}</td>
                    {withAi && <td className={`num ${Math.abs((ai.get(r.key) ?? 0) - r.app) > 0.5 ? 'warn' : 'muted'}`}>{ai.get(r.key) ? fmt(ai.get(r.key)!) : '·'}</td>}
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>
                      <input key={`${r.key}/${r.usado}`} type="number" min={0} step="any" inputMode="decimal" defaultValue={round(r.usado)} style={{ width: 100, fontWeight: r.ajustado ? 700 : undefined }}
                        aria-label={`Planejado para ${r.name}`} title={r.ajustado ? 'Ajustado por você' : 'Estimativa; altere para planejar outro valor'}
                        onBlur={(ev) => { const v = Number(ev.target.value); if (ev.target.value !== '' && Number.isFinite(v) && Math.abs(v - r.usado) > 0.005) void setPlanned(r.key, v) }} />
                      {r.ajustado && <button className="link" style={{ fontSize: 12, marginLeft: 4 }} onClick={() => setPlanned(r.key, null)} aria-label={`Voltar ${r.name} para a estimativa`} title="Voltar para a estimativa">↺</button>}</td>
                    <td className="num"><strong>{fmt(r.real + r.usado)}</strong></td></tr>))]
            })}
          </tbody>
        </table></div>
      </details>
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
        Contas: {nomes.join(', ') || 'nenhuma marcada'}. Receitas só do BCP (as outras contas recebem por transferência). Hoje é dia {day} de {diasNoMes}.
        Falta (app) = o que a Previsão espera pela média de {monthLabel(avgMonths[0])} a {monthLabel(avgMonths.at(-1)!)} e pelos recorrentes que ainda não caíram, mais as linhas manuais.
        {salary && ' O salário que cai a partir do dia 20 é do mês seguinte: fica fora do resultado e do saldo do fim do mês.'}
        {' '}O saldo no fim do mês supõe que tudo o que falta sai destas contas ainda neste mês.
      </p>
    </div>
  )
}

const round = round2
