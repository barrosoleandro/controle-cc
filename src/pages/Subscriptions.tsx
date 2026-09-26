import { useMemo, useState } from 'react'
import type { Ctx } from '../App'
import { detectSubscriptions, subscriptionAlerts, type Subscription } from '../domain/subscriptions'
import { countryOf } from '../domain/countries'
import { isTithe } from '../domain/categorize'
import { addCategory, addRule, setCategoryForTransactions } from '../lib/data'
import { money } from '../lib/format'
import { today, useFmt } from '../lib/hooks'
import type { CategoryKind } from '../domain/types'
import { byName } from '../domain/categorize'

const CADENCIA: Record<Subscription['cadence'], string> = {
  weekly: 'semanal', monthly: 'mensal', quarterly: 'trimestral', yearly: 'anual',
}
const TIPO: Record<CategoryKind, string> = { expense: 'despesa', income: 'receita', transfer: 'transferência' }

export function Subscriptions({ ctx }: { ctx: Ctx }) {
  const fmt = useFmt(ctx)
  const { data, etx } = ctx
  // Account filter (cards included: many subscriptions are charged there). Unticked = hidden.
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  const shown = (id: string) => !hidden.has(id)
  const rows = useMemo(() => etx.filter((t) => !hidden.has(t.account_id) && !isTithe(t.categoryName)), [etx, hidden])
  const subs = useMemo(() => detectSubscriptions(
    rows.map((t) => ({ booking_date: t.booking_date, amount: t.value, merchant: t.merchant, kind: t.kind })), today(),
  ), [rows])
  // Which account(s) each recurring charge comes from.
  const accountsOf = useMemo(() => {
    const name = new Map(data.accounts.map((a) => [a.id, a.name]))
    const m = new Map<string, Set<string>>()
    for (const t of rows) if (t.kind === 'expense' && t.value < 0) m.set(t.merchant, (m.get(t.merchant) ?? new Set()).add(name.get(t.account_id) ?? '?'))
    return m
  }, [rows, data.accounts])
  const alerts = subscriptionAlerts(subs, today(), fmt)
  const ativos = subs.filter((s) => s.status !== 'possibly_cancelled')
  const total = ativos.reduce((s, x) => s + x.monthlyCost, 0)
  const [aberto, setAberto] = useState<string | null>(null)
  return (
    <div className="grid">
      <div className="card" style={{ gridColumn: '1/-1' }}>
        <h3>Cobranças recorrentes — {fmt(total)}/mês · {fmt(total * 12)}/ano{hidden.size ? ' (contas marcadas)' : ''}</h3>
        <div className="row">
          <span className="muted">Contas:</span>
          {[...new Set(data.accounts.map((a) => countryOf(a.bank)))].map((c) => (
            <button key={c} onClick={() => setHidden(new Set(data.accounts.filter((a) => countryOf(a.bank) !== c).map((a) => a.id)))}>{c}</button>
          ))}
          <button onClick={() => setHidden(new Set())}>Todas</button>
          {data.accounts.map((a) => (
            <label key={a.id} className="inline"><input type="checkbox" checked={shown(a.id)} onChange={() => setHidden((prev) => {
              const next = new Set(prev); if (next.has(a.id)) next.delete(a.id); else next.add(a.id); return next
            })} />{a.name}</label>
          ))}
        </div>
        <p className="muted">Detectadas sozinhas: mesmo estabelecimento, intervalo regular e valor estável. Inclui aluguel, empréstimo e seguro, não só streaming. Abra uma linha para ver o histórico e definir a categoria que os próximos imports devem usar.</p>
        <div className="scroll"><table>
          <thead><tr><th>Estabelecimento</th><th className="hide-sm">Conta</th><th>Frequência</th><th className="num">Última</th><th className="num">Por mês</th><th className="hide-sm">Desde</th><th>Próxima</th><th>Situação</th></tr></thead>
          <tbody>{subs.map((s) => {
            const isOpen = aberto === s.merchant
            return [
              <tr key={s.merchant} className={s.status === 'possibly_cancelled' ? 'muted' : ''}>
                <td><button className="link" aria-expanded={isOpen} onClick={() => setAberto(isOpen ? null : s.merchant)}>{isOpen ? '▾' : '▸'} {s.merchant}</button></td>
                <td className="hide-sm muted" style={{ fontSize: 13 }}>{[...(accountsOf.get(s.merchant) ?? [])].join(', ')}</td>
                <td>{CADENCIA[s.cadence]}</td>
                <td className="num">{fmt(s.lastAmount)}{s.priceChangePct > 0.05 && <span className="neg"> ▲{(s.priceChangePct * 100).toFixed(0)}%</span>}</td>
                <td className="num">{fmt(s.monthlyCost)}</td><td className="hide-sm">{s.firstDate}</td><td>{s.nextDate}</td>
                <td>{s.status === 'new' ? 'nova' : s.status === 'possibly_cancelled' ? 'parou?' : 'ativa'}</td>
              </tr>,
              isOpen && <tr key={s.merchant + ':detalhe'}><td colSpan={8}><Detalhe ctx={ctx} sub={s} shown={shown} /></td></tr>,
            ]
          })}</tbody>
        </table></div>
      </div>
      <div className="card"><h3>Alertas</h3>
        {alerts.length ? alerts.map((a) => <div key={a.key} className={`alert ${a.level}`}>{a.level === 'warn' ? '⚠ ' : 'ℹ '}{a.text}</div>) : <p className="muted">Nenhum alerta.</p>}
      </div>
    </div>
  )
}

/** Um recorrente por inteiro: as cobranças e a categoria que os próximos imports devem usar. */
function Detalhe({ ctx, sub, shown }: { ctx: Ctx; sub: Subscription; shown: (accountId: string) => boolean }) {
  const { data, etx } = ctx
  const fmt = useFmt(ctx)
  const cobrancas = useMemo(
    () => etx.filter((t) => t.merchant === sub.merchant && shown(t.account_id)).sort((a, b) => b.booking_date.localeCompare(a.booking_date)),
    [etx, sub.merchant, shown],
  )
  // A categoria que a maioria das cobranças já usa — ponto de partida do seletor.
  const atual = useMemo(() => {
    const contagem = new Map<string, number>()
    for (const t of cobrancas) if (t.category_id) contagem.set(t.category_id, (contagem.get(t.category_id) ?? 0) + 1)
    return [...contagem].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
  }, [cobrancas])
  const regraExistente = data.rules.find((r) => r.pattern.toUpperCase() === sub.merchant.toUpperCase() && r.active !== false)

  const [cat, setCat] = useState(atual)
  const [lembrar, setLembrar] = useState(true)
  const [criando, setCriando] = useState(false)
  const [nome, setNome] = useState('')
  const [tipo, setTipo] = useState<CategoryKind>('expense')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [ok, setOk] = useState(false)
  const cats = [...data.categories].sort(byName)
  const podeLembrar = sub.merchant.length >= 2 && sub.merchant.length <= 100

  /** Cria a categoria e já a seleciona; a regra de import só é escrita no Aplicar. */
  async function criar() {
    const limpo = nome.trim()
    if (!limpo) return
    setBusy(true); setMsg(null)
    try {
      const repetida = data.categories.find((c) => c.name.toLowerCase() === limpo.toLowerCase())
      const criada = repetida ?? (await addCategory(limpo, tipo, '#888888', data.categories.length))
      setCat(criada.id)
      setCriando(false); setNome('')
      setOk(true); setMsg(repetida ? `A categoria "${repetida.name}" já existia — selecionada.` : `Categoria "${limpo}" criada e selecionada.`)
      await ctx.reload()
    } catch (e) { setOk(false); setMsg((e as Error).message) } finally { setBusy(false) }
  }

  async function aplicar() {
    if (!cat) return
    setBusy(true); setMsg(null)
    try {
      await setCategoryForTransactions(cobrancas.map((t) => t.id), cat)
      let aprendeu = ''
      if (lembrar && podeLembrar && !regraExistente) {
        // Menor número de prioridade vence: o que é aprendido aqui bate as regras padrão.
        const priority = Math.min(1000, ...data.rules.map((r) => r.priority)) - 1
        await addRule(sub.merchant, cat, null, priority)
        aprendeu = ` Os próximos imports com "${sub.merchant}" vão usar essa categoria sozinhos.`
      }
      setOk(true); setMsg(`${cobrancas.length} cobranças categorizadas.${aprendeu}`)
      await ctx.reload()
    } catch (e) { setOk(false); setMsg((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <div style={{ padding: '4px 2px 10px' }}>
      <p className="muted">
        {sub.count} cobranças · a cada {sub.intervalDays} dias · média de {fmt(sub.avgAmount)} · {sub.firstDate} → {sub.lastDate} · próxima em {sub.nextDate}
        {sub.priceChangePct > 0.05 && <span className="neg"> · preço subiu {(sub.priceChangePct * 100).toFixed(0)}% em relação às anteriores</span>}
      </p>

      <div className="row">
        <label className="inline">Categoria
          <select value={cat} onChange={(e) => setCat(e.target.value)} disabled={busy}>
            <option value="">—</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <button onClick={() => { setCriando(!criando); setMsg(null) }} disabled={busy}>{criando ? 'Cancelar' : '+ Nova categoria'}</button>
      </div>

      {criando && <div className="row" style={{ marginTop: 6 }}>
        <input placeholder="Nome da categoria" value={nome} onChange={(e) => setNome(e.target.value)} disabled={busy}
          onKeyDown={(e) => { if (e.key === 'Enter') criar() }} />
        <select value={tipo} onChange={(e) => setTipo(e.target.value as CategoryKind)} disabled={busy}>
          {(Object.keys(TIPO) as CategoryKind[]).map((k) => <option key={k} value={k}>{TIPO[k]}</option>)}
        </select>
        <button className="primary" onClick={criar} disabled={busy || !nome.trim()}>Criar</button>
      </div>}

      <div className="row" style={{ marginTop: 6 }}>
        {regraExistente
          ? <span className="muted">✓ Já aprendido: imports com “{regraExistente.pattern}” recebem {regraExistente.category}.</span>
          : <label className="inline"><input type="checkbox" checked={lembrar} disabled={busy || !podeLembrar}
            onChange={(e) => setLembrar(e.target.checked)} /> Lembrar nos próximos imports</label>}
        <button className="primary" onClick={aplicar} disabled={busy || !cat}>Aplicar às {cobrancas.length} cobranças</button>
      </div>
      {msg && <p className={ok ? 'pos' : 'err'}>{msg}</p>}

      <details style={{ marginTop: 8 }}><summary>Histórico de cobranças ({cobrancas.length})</summary>
        <div className="scroll"><table>
          <thead><tr><th>Data</th><th>Descrição</th><th className="hide-sm">Conta</th><th>Categoria</th><th className="num">Valor</th></tr></thead>
          <tbody>{cobrancas.map((t) => (
            <tr key={t.id}>
              <td style={{ whiteSpace: 'nowrap' }}>{t.booking_date}</td>
              <td>{t.description}</td>
              <td className="hide-sm">{t.accountName}</td>
              <td>{t.categoryName}{t.category_locked && <span className="muted" title="escolhida à mão"> ✓</span>}</td>
              <td className={`num ${t.amount < 0 ? 'neg' : 'pos'}`}>{money(t.currency, 2)(t.amount)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      </details>
    </div>
  )
}
