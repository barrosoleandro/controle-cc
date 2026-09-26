import { useState } from 'react'
import type { Ctx } from '../App'
import { addCategory, addRule, deleteRule, deriveOpening, saveFx, setBudget, updateAccount, updateBankMap, updateCategory, updateRule } from '../lib/data'
import { fetchEurBrl } from '../domain/fx'
import { balanceSeries } from '../domain/analytics'
import { money } from '../lib/format'
import { MAPPING_OPEN_QUESTIONS } from '../domain/defaults'
import type { CategoryKind } from '../domain/types'

const SECTIONS = ['Contas', 'Orçamentos', 'Categorias', 'Regras', 'Mapa do banco', 'Cotações'] as const

export function SettingsPage({ ctx }: { ctx: Ctx }) {
  const [sec, setSec] = useState<(typeof SECTIONS)[number]>('Contas')
  return <>
    <div className="row">{SECTIONS.map((s) => <button key={s} className={s === sec ? 'active' : ''} onClick={() => setSec(s)}>{s}</button>)}</div>
    {sec === 'Contas' && <Accounts ctx={ctx} />}
    {sec === 'Orçamentos' && <Budgets ctx={ctx} />}
    {sec === 'Categorias' && <Categories ctx={ctx} />}
    {sec === 'Regras' && <Rules ctx={ctx} />}
    {sec === 'Mapa do banco' && <BankMapping ctx={ctx} />}
    {sec === 'Cotações' && <Fx ctx={ctx} />}
  </>
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
        <details><summary>Detalhes</summary><table><thead><tr><th>Data</th><th className="num">Banco</th><th className="num">Recalculado</th></tr></thead><tbody>
          {cps.slice(0, 40).map((c) => { const r = at(c.date); return <tr key={c.date}><td>{c.date}</td><td className="num">{f(c.balance)}</td><td className={`num ${Math.abs(r - c.balance) < 0.01 ? '' : 'neg'}`}>{f(r)}</td></tr> })}
        </tbody></table></details>
      </div>)
  })}</div>
}

function Budgets({ ctx }: { ctx: Ctx }) {
  const { data } = ctx
  const b = new Map(data.budgets.filter((x) => x.month === null).map((x) => [x.category_id, x.amount]))
  const cats = data.categories.filter((c) => c.kind === 'expense')
  const total = cats.reduce((s, c) => s + (b.get(c.id) ?? 0), 0)
  return <div className="card"><h3>Orçamento mensal (EUR) — total {money('EUR')(total)}</h3>
    <table><tbody>{cats.map((c) => (
      <tr key={c.id}><td>{c.name}</td><td className="num"><input type="number" step="1" min="0" defaultValue={b.get(c.id) ?? ''}
        onBlur={(e) => e.target.value !== '' && Number(e.target.value) !== b.get(c.id) && setBudget(c.id, Number(e.target.value)).then(ctx.reload)} /></td></tr>
    ))}</tbody></table></div>
}

function Categories({ ctx }: { ctx: Ctx }) {
  const { data } = ctx
  const [name, setName] = useState('')
  const [kind, setKind] = useState<CategoryKind>('expense')
  return <div className="card"><h3>Categorias</h3>
    <div className="row"><input placeholder="Nova categoria" value={name} onChange={(e) => setName(e.target.value)} />
      <select value={kind} onChange={(e) => setKind(e.target.value as CategoryKind)}><option value="expense">despesa</option><option value="income">receita</option><option value="transfer">transferência</option></select>
      <button disabled={!name.trim()} onClick={async () => { await addCategory(name.trim(), kind, '#888888', data.categories.length); setName(''); ctx.reload() }}>Adicionar</button></div>
    <table><tbody>{data.categories.map((c) => (
      <tr key={c.id}><td><input defaultValue={c.name} onBlur={(e) => e.target.value.trim() && e.target.value !== c.name && updateCategory(c.id, { name: e.target.value.trim() }).then(ctx.reload)} /></td>
        <td><select value={c.kind} onChange={(e) => updateCategory(c.id, { kind: e.target.value as CategoryKind }).then(ctx.reload)}><option value="expense">despesa</option><option value="income">receita</option><option value="transfer">transferência</option></select></td></tr>
    ))}</tbody></table></div>
}

function Rules({ ctx }: { ctx: Ctx }) {
  const { data } = ctx
  const [pattern, setPattern] = useState('')
  const [cat, setCat] = useState('')
  const cats = [...data.categories].sort((a, b) => a.name.localeCompare(b.name))
  return <div className="grid">
    <div className="card" style={{ gridColumn: '1/-1' }}><h3>Regras por estabelecimento</h3>
      <p className="muted">Conferidas de cima para baixo (menor número de prioridade primeiro); a primeira que casar vence. O texto casa no início de uma palavra, ignorando acento e caixa. As regras rodam antes do mapa de categorias do banco.</p>
      <div className="row"><input placeholder="Texto da descrição, ex.: TEKEL" value={pattern} onChange={(e) => setPattern(e.target.value)} />
        <select value={cat} onChange={(e) => setCat(e.target.value)}><option value="">Categoria…</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <button disabled={pattern.trim().length < 2 || !cat} onClick={async () => { await addRule(pattern.trim(), cat, null, Math.min(1000, ...data.rules.map((r) => r.priority)) - 1); setPattern(''); ctx.reload() }}>Adicionar (prioridade máxima)</button></div>
      <div className="scroll"><table><thead><tr><th className="num">Prio</th><th>Texto</th><th>Sinal</th><th>Categoria</th><th /></tr></thead><tbody>
        {data.rules.map((r) => (
          <tr key={r.id}><td className="num"><input type="number" style={{ width: 70 }} defaultValue={r.priority} onBlur={(e) => Number(e.target.value) !== r.priority && updateRule(r.id, { priority: Number(e.target.value) }).then(ctx.reload)} /></td>
            <td>{r.pattern}</td><td>{r.sign === 'debit' ? 'saída' : r.sign === 'credit' ? 'entrada' : 'qualquer'}</td>
            <td><select value={r.category_id} onChange={(e) => updateRule(r.id, { category_id: e.target.value }).then(ctx.reload)}>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></td>
            <td><button onClick={() => deleteRule(r.id).then(ctx.reload)} aria-label="Excluir regra">✕</button></td></tr>
        ))}</tbody></table></div>
      <p className="muted">Depois de mexer nas regras, use Lançamentos → Reaplicar regras (as escolhas manuais são preservadas).</p>
    </div>
    <div className="card"><h3>Dúvidas em aberto no mapeamento</h3><ul>{MAPPING_OPEN_QUESTIONS.map((q) => <li key={q}>{q}</li>)}</ul></div>
  </div>
}

function BankMapping({ ctx }: { ctx: Ctx }) {
  const { data } = ctx
  const cats = [...data.categories].sort((a, b) => a.name.localeCompare(b.name))
  const seen = new Set(data.transactions.map((t) => `${t.bank_category}|${t.bank_subcategory}`))
  return <div className="card"><h3>Categoria do banco → sua categoria</h3>
    <p className="muted">Usado quando nenhuma regra de estabelecimento casa. “*” = qualquer subcategoria. Em negrito = presente nos seus dados.</p>
    <div className="scroll"><table><thead><tr><th>Categoria do banco</th><th>Subcategoria</th><th>Sua categoria</th></tr></thead><tbody>
      {data.bankMap.map((m) => (
        <tr key={m.id} style={{ fontWeight: seen.has(`${m.bank_category}|${m.bank_subcategory}`) ? 600 : 400 }}>
          <td>{m.bank_category}</td><td>{m.bank_subcategory}</td>
          <td><select value={m.category_id} onChange={(e) => updateBankMap(m.id, e.target.value).then(ctx.reload)}>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></td></tr>
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
