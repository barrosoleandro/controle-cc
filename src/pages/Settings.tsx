import { useEffect, useMemo, useRef, useState } from 'react'
import type { Ctx } from '../App'
import { addCategory, addRule, clearCheckpoints, changeRuleCategory, deleteRule, deriveOpening, mergeCategories, refreshCategories, saveFx, setBudget, updateAccount, updateBankMap, updateCategory, updateRule } from '../lib/data'
import { fetchEurBrl } from '../domain/fx'
import { balanceSeries, enrich } from '../domain/analytics'
import { averageIncome, averageSpendByCategory, salaryAt } from '../domain/budget'
import { monthWindow } from '../domain/period'
import { today } from '../lib/hooks'
import { money, monthLabel } from '../lib/format'
import { MAPPING_OPEN_QUESTIONS } from '../domain/defaults'
import type { CategoryKind } from '../domain/types'
import { byName } from '../domain/categorize'
import { CategorySelect } from '../components/CategorySelect'
import { planMerges } from '../domain/simplify'
import { loadTheme, saveTheme, type Mode, type Theme } from '../lib/theme'

const SECTIONS = ['Contas', 'Orçamentos', 'Categorias', 'Regras', 'Mapa do banco', 'Cotações', 'Aparência'] as const

export function SettingsPage({ ctx }: { ctx: Ctx }) {
  const [sec, setSec] = useState<(typeof SECTIONS)[number]>('Contas')
  return <>
    <div className="row">{SECTIONS.map((s) => <button key={s} className={s === sec ? 'active' : ''} onClick={() => setSec(s)}>{s}</button>)}</div>
    {sec === 'Contas' && <Accounts ctx={ctx} />}
    {sec === 'Aparência' && <Appearance />}
    {sec === 'Orçamentos' && <Budgets ctx={ctx} />}
    {sec === 'Categorias' && <Categories ctx={ctx} />}
    {sec === 'Regras' && <Rules ctx={ctx} />}
    {sec === 'Mapa do banco' && <BankMapping ctx={ctx} />}
    {sec === 'Cotações' && <Fx ctx={ctx} />}
  </>
}

/** Light / dark mode for this device. */
function Appearance() {
  const [t, setT] = useState<Theme>(loadTheme)
  const set = (next: Theme) => { setT(next); saveTheme(next) }
  return <div className="card">
    <h3>Modo</h3>
    <div className="seg" role="group" aria-label="Modo claro ou escuro">
      {([['auto', 'Automático'], ['light', 'Claro'], ['dark', 'Escuro']] as [Mode, string][]).map(([m, l]) => (
        <button key={m} className={t.mode === m ? 'on' : ''} aria-pressed={t.mode === m} onClick={() => set({ mode: m })}>{l}</button>
      ))}
    </div>
    <p className="muted" style={{ fontSize: 13 }}>Automático segue o aparelho. A escolha fica guardada neste aparelho.</p>
  </div>
}

function Accounts({ ctx }: { ctx: Ctx }) {
  const { data } = ctx
  return <div className="grid">{data.accounts.map((a) => {
    const f = money(a.currency, 2)
    const series = balanceSeries(a, data.transactions)
    const at = (d: string) => [...series].reverse().find((p) => p.date <= d)?.balance ?? a.opening_balance
    const cps = data.checkpoints.filter((c) => c.account_id === a.id).sort((x, y) => y.date.localeCompare(x.date))
    const ok = cps.filter((c) => Math.abs(at(c.date) - c.balance) < 0.01).length
    return (
      <div className="card" key={a.id}>
        <h3><input defaultValue={a.name} onBlur={(e) => e.target.value !== a.name && updateAccount(a.id, { name: e.target.value }).then(ctx.reload)} /></h3>
        <p className="muted">{a.bank} · {a.external_ref} · {a.currency} · {a.type}</p>
        <div className="row">
          <label className="inline">Saldo inicial <input type="number" step="0.01" defaultValue={a.opening_balance}
            onBlur={(e) => Number(e.target.value) !== a.opening_balance && updateAccount(a.id, { opening_balance: Number(e.target.value) }).then(ctx.reload)} /></label>
          <button onClick={async () => { const o = deriveOpening(a, data.transactions, data.checkpoints); if (o) { await updateAccount(a.id, o); ctx.reload() } }}>Derivar dos extratos</button>
        </div>
        <p>Saldo atual: <strong>{f(series.at(-1)?.balance ?? a.opening_balance)}</strong></p>
        <p className={ok === cps.length ? 'pos' : 'warn'}>Conciliação: {ok}/{cps.length} saldos do banco conferem.</p>
        {cps.length > 0 && (
          <div className="row">
            {ok < cps.length && <button onClick={async () => {
              const bad = cps.filter((c) => Math.abs(at(c.date) - c.balance) >= 0.01).map((c) => c.date)
              if (confirm(`Apagar ${bad.length} saldo(s) do banco que não conferem em ${a.name} e recalcular o saldo inicial com os que sobram?`)) { await clearCheckpoints(a.id, bad); ctx.reload() }
            }}>Apagar os que não conferem ({cps.length - ok})</button>}
            <button onClick={async () => {
              if (confirm(`Limpar todos os ${cps.length} saldos do banco de ${a.name}? Os lançamentos e o saldo inicial ficam como estão; ao importar extratos de novo, o saldo inicial é recalculado.`)) {
                await clearCheckpoints(a.id, 'all'); ctx.reload()
              }
            }}>Limpar todos os saldos</button>
          </div>
        )}
        <details><summary>Detalhes ({cps.length} saldos do banco)</summary>
          <div className="scroll" style={{ maxHeight: 360, overflowY: 'auto' }}><table><thead><tr><th>Data</th><th className="num">Banco</th><th className="num">Recalculado</th><th /></tr></thead><tbody>
            {cps.map((c) => {
              const r = at(c.date)
              return <tr key={c.date}><td>{c.date}</td><td className="num">{f(c.balance)}</td><td className={`num ${Math.abs(r - c.balance) < 0.01 ? '' : 'neg'}`}>{f(r)}</td>
                <td><button className="link" title="Apagar este saldo" aria-label={`Apagar o saldo de ${c.date}`}
                  onClick={async () => { await clearCheckpoints(a.id, [c.date]); ctx.reload() }}>✕</button></td></tr>
            })}
          </tbody></table></div></details>
      </div>)
  })}</div>
}

/**
 * Monthly budget per expense category (EUR). Each category shows its average spending over
 * the last 12 complete months; when no expense category has a budget yet, the averages are
 * loaded as the starting budgets, and the buttons refill empty ones or all of them later.
 */
function Budgets({ ctx }: { ctx: Ctx }) {
  const { data, fx } = ctx
  const b = new Map(data.budgets.filter((x) => x.month === null).map((x) => [x.category_id, x.amount]))
  const cats = data.categories.filter((c) => c.kind === 'expense').sort(byName)
  const total = cats.reduce((s, c) => s + (b.get(c.id) ?? 0), 0)
  const eur = money('EUR')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  // Last 12 complete months, all accounts, converted to EUR like the budgets.
  const months = useMemo(() => monthWindow(today().slice(0, 7), 13).slice(0, 12), [])
  const avg = useMemo(
    () => averageSpendByCategory(enrich(data.transactions, data.categories, data.accounts, fx, 'EUR'), months),
    [data.transactions, data.categories, data.accounts, fx, months],
  )
  const totalAvg = cats.reduce((s, c) => s + (avg.get(c.id) ?? 0), 0)
  // Last quarter: the 3 most recent complete months, for budgets that follow recent habits.
  const quarter = useMemo(() => months.slice(-3), [months])
  const avg3 = useMemo(
    () => averageSpendByCategory(enrich(data.transactions, data.categories, data.accounts, fx, 'EUR'), quarter),
    [data.transactions, data.categories, data.accounts, fx, quarter],
  )
  const totalAvg3 = cats.reduce((s, c) => s + (avg3.get(c.id) ?? 0), 0)

  /** Writes the chosen average into the budgets: only empty ones, or all of them. */
  async function fill(all: boolean, source: 'year' | 'quarter' = 'year') {
    const values = source === 'quarter' ? avg3 : avg
    const range = source === 'quarter' ? quarter : months
    // Updating from the quarter also sets categories with no spending in it back to zero.
    const todo = source === 'quarter' ? cats.filter((c) => (values.get(c.id) ?? 0) !== (b.get(c.id) ?? 0))
      : cats.filter((c) => values.get(c.id) && (all || !b.get(c.id)))
    if (!todo.length) { setMsg('Nada para atualizar.'); return }
    setBusy(true); setMsg(null)
    try {
      for (const c of todo) await setBudget(c.id, values.get(c.id) ?? 0)
      setMsg(`${todo.length} orçamento(s) atualizado(s) com a média de ${range[0]} a ${range.at(-1)}.`)
      await ctx.reload()
    } catch (e) { setMsg((e as Error).message) } finally { setBusy(false) }
  }

  // First visit with no budgets for the current categories: start from the averages.
  const started = useRef(false)
  useEffect(() => {
    if (started.current || busy || !avg.size || cats.some((c) => b.get(c.id))) return
    started.current = true
    fill(false)
  }) // eslint-disable-line react-hooks/exhaustive-deps

  return <><Salary ctx={ctx} budgetTotal={total} quarter={quarter} />
  <div className="card"><h3>Orçamento mensal (EUR) — total {eur(total)}</h3>
    <p className="muted">A média considera {months[0]} a {months.at(-1)}, todas as contas convertidas para euro, meses sem gasto contando como zero
      (uma conta anual fica dividida pelos 12 meses), arredondada para cima de 10 em 10. Total das médias: {eur(totalAvg)} em 12 meses,
      {' '}{eur(totalAvg3)} no último trimestre ({quarter[0]} a {quarter.at(-1)}).</p>
    <div className="row">
      <button onClick={() => fill(false)} disabled={busy}>Preencher vazios com a média</button>
      <button onClick={() => { if (confirm('Substituir todos os orçamentos pela média dos últimos 12 meses?')) fill(true) }} disabled={busy}>Substituir todos pela média de 12 meses</button>
      <button className="primary" onClick={() => { if (confirm(`Atualizar todos os orçamentos pela média de ${quarter[0]} a ${quarter.at(-1)}?`)) fill(true, 'quarter') }} disabled={busy}>Atualizar pelo último trimestre</button>
      {msg && <span className="muted">{msg}</span>}
    </div>
    <table><thead><tr><th>Categoria</th><th className="num">Média 12m</th><th className="num">Média trimestre</th><th className="num">Orçamento</th></tr></thead>
      <tbody>{cats.map((c) => {
        const a = avg.get(c.id) ?? 0
        const v = b.get(c.id)
        const a3 = avg3.get(c.id) ?? 0
        return <tr key={c.id}><td>{c.name}</td><td className="num muted">{a ? eur(a) : '—'}</td>
          <td className={`num ${a3 > a * 1.2 && a3 - a >= 20 ? 'neg' : 'muted'}`} title={a3 > a * 1.2 && a3 - a >= 20 ? 'Gasto recente acima da média do ano' : undefined}>{a3 ? eur(a3) : '—'}</td>
          <td className="num"><input key={`${c.id}:${v ?? ''}`} type="number" step="1" min="0" defaultValue={v ?? ''} placeholder={a ? String(a) : ''} disabled={busy}
            className={v && a && v < a ? 'warn' : ''} title={v && a && v < a ? 'Abaixo da média gasta' : undefined}
            onBlur={(e) => e.target.value !== '' && Number(e.target.value) !== v && setBudget(c.id, Number(e.target.value)).then(ctx.reload)} /></td></tr>
      })}</tbody></table></div></>
}

/**
 * Net monthly salary (EUR) next to the budget. The new value applies from the current month
 * on; the previous one is the value in force last month (typed here, or, with no history, the
 * average received in the last quarter). The card shows the change and what is left of the
 * salary after the expense budget, before and after.
 */
function Salary({ ctx, budgetTotal, quarter }: { ctx: Ctx; budgetTotal: number; quarter: string[] }) {
  const { data, fx } = ctx
  const eur = money('EUR')
  const signed = (n: number) => `${n > 0 ? '+' : ''}${eur(n)}`
  const cat = data.categories.find((c) => c.kind === 'income' && c.name === 'Salario')
  const cur = today().slice(0, 7)
  const prev = monthWindow(cur, 2)[0]
  const rows = cat ? data.budgets.filter((b) => b.category_id === cat.id) : []
  const etx = useMemo(() => enrich(data.transactions, data.categories, data.accounts, fx, 'EUR'), [data.transactions, data.categories, data.accounts, fx])
  const received = cat ? averageIncome(etx, cat.id, quarter) : 0
  const thisMonth = cat ? averageIncome(etx, cat.id, [cur]) : 0
  if (!cat) return <div className="card"><h3>Salário</h3><p className="muted">Crie uma categoria de receita chamada “Salario” para planejar o salário.</p></div>

  const now = salaryAt(rows, cur)
  const newValue = now?.since === cur ? now.amount : undefined
  const typedBefore = salaryAt(rows, prev)
  const before = typedBefore?.amount ?? received
  const after = now?.amount
  const save = (v: string, month: string, old: number | undefined) => {
    if (v === '' || Number(v) === old) return
    setBudget(cat.id, Number(v), `${month}-01`).then(ctx.reload)
  }
  const history = rows.filter((r) => r.month).sort((a, b) => a.month!.localeCompare(b.month!))

  return <div className="card"><h3>Salário líquido mensal (EUR)</h3>
    <div className="row">
      <label className="inline">Anterior (até {monthLabel(prev)})
        <input key={`p:${typedBefore?.amount ?? ''}`} type="number" step="1" min="0" defaultValue={typedBefore?.amount ?? ''} placeholder={received ? String(Math.round(received)) : ''}
          onBlur={(e) => save(e.target.value, typedBefore?.since ?? prev, typedBefore?.amount)} /></label>
      <label className="inline">Novo (a partir de {monthLabel(cur)})
        <input key={`n:${newValue ?? ''}`} type="number" step="1" min="0" defaultValue={newValue ?? ''} placeholder={after !== undefined ? String(after) : ''}
          onBlur={(e) => save(e.target.value, cur, newValue)} /></label>
    </div>
    <p className="muted" style={{ fontSize: 13 }}>
      {typedBefore ? `Anterior: valor informado desde ${monthLabel(typedBefore.since)}.` : `Anterior: média recebida de ${monthLabel(quarter[0])} a ${monthLabel(quarter.at(-1)!)} (${eur(received)}), até você informar o valor.`}
      {' '}Recebido em {monthLabel(cur)} até agora: {eur(thisMonth)}.
    </p>
    {after === undefined ? <p className="muted">Informe o salário novo para ver o impacto.</p> : (() => {
      const diff = after - before
      const pct = before ? diff / before : 0
      const cls = diff > 0 ? 'pos' : diff < 0 ? 'neg' : ''
      return <div className="kpis">
        <div className="kpi"><div className="l">Diferença por mês</div><div className={`v ${cls}`}>{signed(diff)}</div>
          <div className="d muted">{before ? `${pct > 0 ? '+' : ''}${(pct * 100).toFixed(1).replace('.', ',')}% sobre ${eur(before)}` : '—'}</div></div>
        <div className="kpi"><div className="l">Diferença em 12 meses</div><div className={`v ${cls}`}>{signed(diff * 12)}</div></div>
        <div className="kpi"><div className="l">Sobra após o orçamento ({eur(budgetTotal)})</div><div className={`v ${after - budgetTotal < 0 ? 'neg' : ''}`}>{eur(after - budgetTotal)}</div>
          <div className="d muted">antes {eur(before - budgetTotal)}</div></div>
        <div className="kpi"><div className="l">Orçamento / salário</div><div className={`v ${budgetTotal > after ? 'neg' : ''}`}>{after ? `${Math.round((budgetTotal / after) * 100)}%` : '—'}</div>
          <div className="d muted">antes {before ? `${Math.round((budgetTotal / before) * 100)}%` : '—'}</div></div>
      </div>
    })()}
    {history.length > 0 && <p className="muted" style={{ fontSize: 13 }}>Histórico: {history.map((r) => `${monthLabel(r.month!.slice(0, 7))} ${eur(r.amount)}`).join(' · ')}</p>}
  </div>
}

function Categories({ ctx }: { ctx: Ctx }) {
  return <div className="grid">
    <Simplify ctx={ctx} />
    <Merge ctx={ctx} />
    <CategoryList ctx={ctx} />
  </div>
}

/** One-click version of the suggested simplification, with a preview of what each merge moves. */
function Simplify({ ctx }: { ctx: Ctx }) {
  const { data } = ctx
  const steps = planMerges(data.categories)
  const [skip, setSkip] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const count = new Map<string, number>()
  for (const t of data.transactions) if (t.category_id) count.set(t.category_id, (count.get(t.category_id) ?? 0) + 1)
  const chosen = steps.filter((s) => !skip.has(s.target))

  async function aplicar() {
    if (!confirm(`Aplicar ${chosen.length} fusões? As categorias de origem serão apagadas depois de mover lançamentos, regras e orçamentos.`)) return
    setBusy(true); setMsg(null)
    try {
      let moved = 0
      for (const s of chosen) {
        let targetId = s.keep?.id
        if (!targetId) targetId = (await addCategory(s.target, s.kind, '#888888', data.categories.length)).id
        else if (s.keep!.name !== s.target || s.keep!.kind !== s.kind) await updateCategory(targetId, { name: s.target, kind: s.kind })
        moved += await mergeCategories(s.absorb.map((c) => c.id), targetId, data.budgets)
      }
      setMsg(`${chosen.length} categorias ajustadas · ${moved} lançamentos movidos.`)
      await ctx.reload()
    } catch (e) { setMsg((e as Error).message) } finally { setBusy(false) }
  }

  if (!steps.length) return <div className="card" style={{ gridColumn: '1/-1' }}><h3>Simplificar categorias</h3><p className="pos">Suas categorias já estão simplificadas.</p>{msg && <p className="muted">{msg}</p>}</div>
  return <div className="card" style={{ gridColumn: '1/-1' }}><h3>Simplificar categorias</h3>
    <p className="muted">Proposta: menos categorias, mais largas. O nome do estabelecimento continua aparecendo dentro de cada categoria (Lançamentos → 6 meses → ▸).
      Transfer, Cartão Itaú, Imóvel Brasil, Business Trips, Reembolso, Rendimentos e Outras receitas ficam como estão. Desmarque o que não quiser.</p>
    <div className="scroll"><table>
      <thead><tr><th /><th>Fica</th><th>Absorve</th><th className="num">Lançamentos</th></tr></thead>
      <tbody>{steps.map((s) => (
        <tr key={s.target}>
          <td><input type="checkbox" checked={!skip.has(s.target)} disabled={busy} aria-label={`Aplicar ${s.target}`}
            onChange={() => setSkip((prev) => { const n = new Set(prev); if (n.has(s.target)) n.delete(s.target); else n.add(s.target); return n })} /></td>
          <td><strong>{s.target}</strong>{s.keep && s.keep.name !== s.target && <span className="muted"> (renomeia “{s.keep.name}”)</span>}
            {s.note && <div className="warn" style={{ fontSize: 12 }}>{s.note}</div>}</td>
          <td>{s.absorb.map((c) => c.name).join(', ') || <span className="muted">—</span>}</td>
          <td className="num">{[s.keep, ...s.absorb].reduce((n, c) => n + (c ? count.get(c.id) ?? 0 : 0), 0)}</td>
        </tr>
      ))}</tbody>
    </table></div>
    <div className="row" style={{ marginTop: 10 }}>
      <button className="primary" onClick={aplicar} disabled={busy || !chosen.length}>Aplicar {chosen.length} fusões</button>
      {msg && <span className="muted">{msg}</span>}
    </div>
  </div>
}

/** Merge any category into another by hand. */
function Merge({ ctx }: { ctx: Ctx }) {
  const { data } = ctx
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const nameOf = (id: string) => data.categories.find((c) => c.id === id)?.name ?? ''
  const n = data.transactions.filter((t) => t.category_id === from).length

  async function mesclar() {
    if (!confirm(`Mover ${n} lançamentos, as regras e o orçamento de “${nameOf(from)}” para “${nameOf(to)}” e apagar “${nameOf(from)}”?`)) return
    setBusy(true); setMsg(null)
    try {
      const moved = await mergeCategories([from], to, data.budgets)
      setMsg(`“${nameOf(from)}” mesclada em “${nameOf(to)}” · ${moved} lançamentos movidos.`)
      setFrom('')
      await ctx.reload()
    } catch (e) { setMsg((e as Error).message) } finally { setBusy(false) }
  }

  return <div className="card" style={{ gridColumn: '1/-1' }}><h3>Mesclar categorias</h3>
    <p className="muted">Move lançamentos, regras, mapa do banco e orçamento da primeira para a segunda e apaga a primeira. As escolhas feitas à mão continuam travadas.</p>
    <div className="row">
      <CategorySelect ctx={ctx} value={from} onChange={setFrom} empty="Mesclar esta…" label="Categoria de origem" disabled={busy} />
      <span>→</span>
      <CategorySelect ctx={ctx} value={to} onChange={setTo} empty="…nesta" label="Categoria de destino" disabled={busy} />
      <button className="primary" onClick={mesclar} disabled={busy || !from || !to || from === to}>Mesclar{from ? ` (${n} lançamentos)` : ''}</button>
    </div>
    {msg && <p className="muted">{msg}</p>}
  </div>
}

function CategoryList({ ctx }: { ctx: Ctx }) {
  const { data } = ctx
  const [name, setName] = useState('')
  const [kind, setKind] = useState<CategoryKind>('expense')
  return <div className="card" style={{ gridColumn: '1/-1' }}><h3>Categorias</h3>
    <div className="row"><input placeholder="Nova categoria" value={name} onChange={(e) => setName(e.target.value)} />
      <select value={kind} onChange={(e) => setKind(e.target.value as CategoryKind)}><option value="expense">despesa</option><option value="income">receita</option><option value="transfer">transferência</option></select>
      <button disabled={!name.trim()} onClick={async () => { await addCategory(name.trim(), kind, '#888888', data.categories.length); setName(''); ctx.reload() }}>Adicionar</button></div>
    <table><tbody>{[...data.categories].sort(byName).map((c) => (
      <tr key={c.id}><td><input defaultValue={c.name} onBlur={(e) => e.target.value.trim() && e.target.value !== c.name && updateCategory(c.id, { name: e.target.value.trim() }).then(ctx.reload)} /></td>
        <td><select value={c.kind} onChange={(e) => updateCategory(c.id, { kind: e.target.value as CategoryKind }).then(ctx.reload)}><option value="expense">despesa</option><option value="income">receita</option><option value="transfer">transferência</option></select></td></tr>
    ))}</tbody></table></div>
}

function Rules({ ctx }: { ctx: Ctx }) {
  const { data } = ctx
  const [pattern, setPattern] = useState('')
  const [cat, setCat] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  /** Every rule change is followed by a refresh of the whole base, so the lists never lag behind. */
  async function run(change: () => Promise<number | void>) {
    setBusy(true); setMsg(null)
    try {
      const direct = await change() // a number means the change already refreshed the base
      const n = typeof direct === 'number' ? direct : await refreshCategories()
      setMsg(`${n} lançamento(s) recategorizados.`)
      await ctx.reload()
    } catch (e) { setMsg((e as Error).message) } finally { setBusy(false) }
  }
  return <div className="grid">
    <div className="card" style={{ gridColumn: '1/-1' }}><h3>Regras por estabelecimento</h3>
      <p className="muted">Conferidas de cima para baixo (menor número de prioridade primeiro); a primeira que casar vence. O texto casa no início de uma palavra, ignorando acento e caixa. As regras rodam antes do mapa de categorias do banco.</p>
      <p className="muted">Toda mudança aqui recategoriza a base inteira na hora. As linhas que você mudou à mão continuam como estão, exceto as que tinham a categoria antiga da regra alterada.</p>
      <div className="row">
        <button onClick={() => run(async () => { /* só atualizar */ })} disabled={busy}>Atualizar categorias agora</button>
        {busy && <span className="muted">Atualizando…</span>}
        {msg && <span className="muted">{msg}</span>}
      </div>
      <div className="row"><input placeholder="Texto da descrição, ex.: TEKEL" value={pattern} onChange={(e) => setPattern(e.target.value)} />
        <CategorySelect ctx={ctx} value={cat} onChange={setCat} empty="Categoria…" label="Categoria da nova regra" />
        <button disabled={busy || pattern.trim().length < 2 || !cat} onClick={() => run(async () => { await addRule(pattern.trim(), cat, null, Math.min(1000, ...data.rules.map((r) => r.priority)) - 1); setPattern('') })}>Adicionar (prioridade máxima)</button></div>
      <div className="scroll"><table><thead><tr><th className="num">Prio</th><th>Texto</th><th>Sinal</th><th>Categoria</th><th /></tr></thead><tbody>
        {data.rules.map((r) => (
          <tr key={r.id}><td className="num"><input type="number" style={{ width: 70 }} defaultValue={r.priority} onBlur={(e) => { if (Number(e.target.value) !== r.priority) run(() => updateRule(r.id, { priority: Number(e.target.value) })) }} /></td>
            <td>{r.pattern}</td><td>{r.sign === 'debit' ? 'saída' : r.sign === 'credit' ? 'entrada' : 'qualquer'}</td>
            <td><CategorySelect ctx={ctx} value={r.category_id} label={`Categoria da regra ${r.pattern}`}
              disabled={busy} onChange={(id) => run(() => changeRuleCategory(data, r, id))} /></td>
            <td><button onClick={() => run(() => deleteRule(r.id))} disabled={busy} aria-label="Excluir regra">✕</button></td></tr>
        ))}</tbody></table></div>
    </div>
    <div className="card"><h3>Dúvidas em aberto no mapeamento</h3><ul>{MAPPING_OPEN_QUESTIONS.map((q) => <li key={q}>{q}</li>)}</ul></div>
  </div>
}

function BankMapping({ ctx }: { ctx: Ctx }) {
  const { data } = ctx
  const seen = new Set(data.transactions.map((t) => `${t.bank_category}|${t.bank_subcategory}`))
  return <div className="card"><h3>Categoria do banco → sua categoria</h3>
    <p className="muted">Usado quando nenhuma regra de estabelecimento casa. “*” = qualquer subcategoria. Em negrito = presente nos seus dados.</p>
    <div className="scroll"><table><thead><tr><th>Categoria do banco</th><th>Subcategoria</th><th>Sua categoria</th></tr></thead><tbody>
      {data.bankMap.map((m) => (
        <tr key={m.id} style={{ fontWeight: seen.has(`${m.bank_category}|${m.bank_subcategory}`) ? 600 : 400 }}>
          <td>{m.bank_category}</td><td>{m.bank_subcategory}</td>
          <td><CategorySelect ctx={ctx} value={m.category_id} label={`Categoria para ${m.bank_category}`}
            onChange={(id) => updateBankMap(m.id, id).then(refreshCategories).then(ctx.reload)} /></td></tr>
      ))}</tbody></table></div></div>
}

function Fx({ ctx }: { ctx: Ctx }) {
  const [msg, setMsg] = useState<string | null>(null)
  const first = ctx.data.transactions[0]?.booking_date ?? '2025-01-01'
  return <div className="card"><h3>Cotações EUR → BRL</h3>
    <p>{ctx.data.fx.size} cotações diárias guardadas. Última: {ctx.fx.latest().toFixed(4)}</p>
    <button onClick={async () => {
      try { const r = await fetchEurBrl(first, new Date().toISOString().slice(0, 10)); await saveFx(r); setMsg(`${r.size} cotações atualizadas (BCE via Frankfurter).`); ctx.reload() }
      catch (e) { setMsg((e as Error).message) }
    }}>Atualizar cotações</button>
    {msg && <p className="muted">{msg}</p>}
  </div>
}
