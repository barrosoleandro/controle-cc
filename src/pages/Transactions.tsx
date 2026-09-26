import { Fragment, useCallback, useMemo, useState } from 'react'
import type { Ctx } from '../App'
import { addCategory, markAiNote, reapplyRules, setCategoryForTransactions, setMerchantCategory, setTransactionCategory, setTransactionNote } from '../lib/data'
import { CategorySelect } from '../components/CategorySelect'
import { money } from '../lib/format'
import { today, useFmt, useSubscriptions } from '../lib/hooks'
import { buildPeriod, monthBalances, monthWindow, subscriptionReview, type PeriodRow } from '../domain/period'
import type { CategoryKind } from '../domain/types'
import { byName, isTithe } from '../domain/categorize'
import { countryOf, flowsByCountry, type Country } from '../domain/countries'
import { purchaseDate } from '../domain/simplify'

const TIPO: Record<CategoryKind, string> = { expense: 'despesa', income: 'receita', transfer: 'transferência' }
const NEW = '__new' // select option that opens the new-category form

const VIEWS = ['1 mês', '6 meses', '12 meses', '24 meses', 'Por país', 'Lista'] as const
const MONTHS: Record<string, number> = { '1 mês': 1, '6 meses': 6, '12 meses': 12, '24 meses': 24 }

export function Transactions({ ctx }: { ctx: Ctx }) {
  const [view, setView] = useState<(typeof VIEWS)[number]>('6 meses')
  const [merchant, setMerchant] = useState('') // set from a month view: the list shows only this merchant
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  const shown = useCallback((id: string) => !hidden.has(id), [hidden])
  return <>
    <div className="row">{VIEWS.map((v) => (
      <button key={v} className={v === view ? 'active' : ''} onClick={() => { setView(v); setMerchant('') }}>{v}</button>
    ))}</div>
    <div className="row">
      <span className="muted">Contas:</span>
      {/* Shortcuts: tick only the accounts of one country, or all of them. */}
      {[...new Set(ctx.data.accounts.map((a) => countryOf(a.bank)))].map((c) => (
        <button key={c} onClick={() => setHidden(new Set(ctx.data.accounts.filter((a) => countryOf(a.bank) !== c).map((a) => a.id)))}>{c}</button>
      ))}
      <button onClick={() => setHidden(new Set())}>Todas</button>
      {ctx.data.accounts.map((a) => (
        <label key={a.id} className="inline"><input type="checkbox" checked={shown(a.id)} onChange={() => setHidden((prev) => {
          const next = new Set(prev); if (next.has(a.id)) next.delete(a.id); else next.add(a.id); return next
        })} />{a.name}</label>
      ))}
    </div>
    {view === 'Lista'
      ? <Lista ctx={ctx} shown={shown} merchant={merchant} onClearMerchant={() => setMerchant('')} />
      : view === 'Por país'
        ? <PorPais ctx={ctx} shown={shown} />
        : <Periodo ctx={ctx} shown={shown} n={MONTHS[view]} onOpen={(m) => { setMerchant(m); setView('Lista') }} />}
  </>
}

function Lista({ ctx, shown, merchant, onClearMerchant }: { ctx: Ctx; shown: (accountId: string) => boolean; merchant: string; onClearMerchant: () => void }) {
  const fmt = useFmt(ctx)
  const { data, etx } = ctx
  const [q, setQ] = useState('')
  const [month, setMonth] = useState('')
  // Purchase-date range (the FACT date on card lines), e.g. the days of a business trip.
  const [de, setDe] = useState('')
  const [ate, setAte] = useState('')
  const [cat, setCat] = useState('')
  const [limit, setLimit] = useState(200)
  const [ordem, setOrdem] = useState<'data' | 'valor'>('data')
  const [msg, setMsg] = useState<string | null>(null)
  const [sel, setSel] = useState<Set<string>>(() => new Set())
  const [bulkCat, setBulkCat] = useState('')
  // Where a category created in the form goes: the selected lines, or one line's whole merchant.
  const [nova, setNova] = useState<null | { target: 'sel' } | { target: 'row'; id: string; merchant: string }>(null)
  const [nome, setNome] = useState('')
  const [tipo, setTipo] = useState<CategoryKind>('expense')
  const [busy, setBusy] = useState(false)
  const months = useMemo(() => [...new Set(etx.map((t) => t.month))].sort().reverse(), [etx])
  const sortedCats = [...data.categories].sort(byName)

  const rows = useMemo(() => {
    const qq = q.trim().toUpperCase()
    const inRange = (t: { description: string; booking_date: string }) => {
      const d = purchaseDate(t.description, t.booking_date)
      return (!de || d >= de) && (!ate || d <= ate)
    }
    return etx.filter((t) => (!merchant || t.merchant === merchant) && (!month || t.month === month) && shown(t.account_id) && inRange(t)
      && (!cat || (cat === '__none' ? !t.category_id : t.category_id === cat))
      && (!qq || t.description.toUpperCase().includes(qq) || (t.notes ?? '').toUpperCase().includes(qq)))
      // "valor": biggest spending first (most negative), then the rest.
      .sort((a, b) => (ordem === 'valor' ? a.value - b.value : b.booking_date.localeCompare(a.booking_date)))
  }, [etx, q, month, cat, shown, de, ate, merchant, ordem])
  const total = rows.reduce((s, t) => s + t.value, 0)

  /** A category picked on one line applies to the merchant's whole history and its rule; see setMerchantCategory. */
  async function changeCategory(t: { id: string; merchant: string }, categoryId: string) {
    setBusy(true); setMsg(null)
    try {
      if (categoryId && t.merchant.length >= 2) {
        const n = await setMerchantCategory(data, t.merchant, categoryId)
        setMsg(`"${t.merchant}": ${n} lançamento(s) atualizados e regra salva para os próximos imports.`)
      } else {
        await setTransactionCategory(t.id, categoryId || null)
        await markAiNote(data.transactions.filter((x) => x.id === t.id), false)
      }
      await ctx.reload()
    } catch (e) { setMsg(`Não foi possível mudar a categoria: ${(e as Error).message}`) } finally { setBusy(false) }
  }

  /** Only the selected lines change; they are locked so rules leave them alone, and the merchant rule stays as it is. */
  async function applyToSelected(categoryId: string) {
    const chosen = data.transactions.filter((x) => sel.has(x.id))
    if (!chosen.length || !categoryId) return
    setBusy(true); setMsg(null)
    try {
      await setCategoryForTransactions(chosen.map((x) => x.id), categoryId)
      await markAiNote(chosen, false)
      setMsg(`${chosen.length} lançamento(s) alterados só nestas linhas; a regra do estabelecimento não mudou.`)
      setSel(new Set()); setBulkCat('')
      await ctx.reload()
    } catch (e) { setMsg(`Não foi possível mudar a categoria: ${(e as Error).message}`) } finally { setBusy(false) }
  }

  async function criarCategoria() {
    const limpo = nome.trim()
    if (!limpo || !nova) return
    setBusy(true); setMsg(null)
    try {
      const repetida = data.categories.find((c) => c.name.toLowerCase() === limpo.toLowerCase())
      const criada = repetida ?? (await addCategory(limpo, tipo, '#888888', data.categories.length))
      if (nova.target === 'sel') await applyToSelected(criada.id)
      else await changeCategory({ id: nova.id, merchant: nova.merchant }, criada.id)
      setNova(null); setNome('')
    } catch (e) { setMsg((e as Error).message) } finally { setBusy(false) }
  }

  const openNova = (target: NonNullable<typeof nova>) => { setNova(target); setNome(''); setTipo('expense') }
  const visible = rows.slice(0, limit)
  const allSelected = visible.length > 0 && visible.every((t) => sel.has(t.id))
  const toggleRow = (id: string) => setSel((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })

  function exportCsv() {
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`
    const lines = ['data;conta;descricao;valor;moeda;categoria;observacao', ...rows.map((t) =>
      [t.booking_date, esc(t.accountName), esc(t.description), t.amount.toFixed(2), t.currency, esc(t.categoryName), esc(t.notes ?? '')].join(';'))]
    const url = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv' }))
    const a = document.createElement('a'); a.href = url; a.download = 'lancamentos.csv'; a.click(); URL.revokeObjectURL(url)
  }

  return (
    <div className="card">
      <div className="row">
        <input placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={month} onChange={(e) => setMonth(e.target.value)}><option value="">Todos os meses</option>{months.map((m) => <option key={m}>{m}</option>)}</select>
        <label className="inline" title="Data da compra (FACT no extrato), não a data em que o banco lançou">Compra de
          <input type="date" value={de} onChange={(e) => setDe(e.target.value)} /></label>
        <label className="inline">até <input type="date" value={ate} onChange={(e) => setAte(e.target.value)} /></label>
        <label className="inline">Ordenar por
          <select value={ordem} onChange={(e) => setOrdem(e.target.value as 'data' | 'valor')}>
            <option value="data">data</option><option value="valor">valor (maiores gastos primeiro)</option>
          </select></label>
        <select value={cat} onChange={(e) => setCat(e.target.value)}><option value="">Todas as categorias</option><option value="__none">(sem categoria)</option>{sortedCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <button onClick={exportCsv}>Exportar CSV</button>
        <button onClick={async () => { const n = await reapplyRules(data); setMsg(`${n} lançamentos recategorizados.`); ctx.reload() }}>Reaplicar regras</button>
      </div>
      {merchant && <p className="row alert" style={{ justifyContent: 'space-between' }}>
        <span>Só <strong>{merchant}</strong></span><button onClick={onClearMerchant}>Ver todos</button></p>}
      <p className="muted">{rows.length} lançamentos · saldo {fmt(total)}{msg ? ` · ${msg}` : ''}</p>
      <p className="muted" style={{ fontSize: 12 }}>
        Trocar a categoria na linha muda todo o histórico daquele estabelecimento. Para mudar só algumas linhas, marque-as e use
        “Aplicar só nestas linhas”. Em qualquer lista de categorias, “+ Nova categoria…” cria uma nova.
      </p>
      {sel.size > 0 && (
        <div className="row alert">
          <strong>{sel.size} selecionada(s)</strong>
          <select value={bulkCat} disabled={busy} aria-label="Categoria para as linhas selecionadas"
            onChange={(e) => (e.target.value === NEW ? openNova({ target: 'sel' }) : setBulkCat(e.target.value))}>
            <option value="">Escolha a categoria…</option>
            {sortedCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            <option value={NEW}>+ Nova categoria…</option>
          </select>
          <button className="primary" disabled={!bulkCat || busy} onClick={() => applyToSelected(bulkCat)}>Aplicar só nestas linhas</button>
          <button onClick={() => setSel(new Set())} disabled={busy}>Limpar seleção</button>
        </div>
      )}
      {nova && (
        <div className="row alert">
          <span>Nova categoria {nova.target === 'sel' ? `para ${sel.size} linha(s) selecionada(s)` : `para todo o histórico de “${nova.merchant}”`}</span>
          <input placeholder="Nome da categoria" value={nome} onChange={(e) => setNome(e.target.value)} disabled={busy} autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') criarCategoria() }} />
          <select value={tipo} onChange={(e) => setTipo(e.target.value as CategoryKind)} disabled={busy}>
            {(Object.keys(TIPO) as CategoryKind[]).map((k) => <option key={k} value={k}>{TIPO[k]}</option>)}
          </select>
          <button className="primary" onClick={criarCategoria} disabled={busy || !nome.trim()}>Criar e aplicar</button>
          <button onClick={() => setNova(null)} disabled={busy}>Cancelar</button>
        </div>
      )}
      <div className="scroll"><table>
        <thead><tr><th><input type="checkbox" checked={allSelected} aria-label="Selecionar todas as linhas visíveis"
          onChange={() => setSel(allSelected ? new Set() : new Set(visible.map((t) => t.id)))} /></th><th>Data</th><th>Descrição</th><th className="hide-sm">Conta</th><th>Categoria</th><th className="num">Valor</th></tr></thead>
        <tbody>
          {visible.map((t) => (
            <tr key={t.id}>
              <td><input type="checkbox" checked={sel.has(t.id)} onChange={() => toggleRow(t.id)} aria-label={`Selecionar ${t.description}`} /></td>
              <td style={{ whiteSpace: 'nowrap' }}>{t.booking_date.slice(5)}</td>
              <td>{t.description}{t.bank_subcategory && <div className="muted" style={{ fontSize: 12 }}>{t.bank_subcategory}</div>}
                <input style={{ marginTop: 4, width: '100%', fontSize: 12, padding: '2px 6px' }} placeholder="observação" defaultValue={t.notes ?? ''}
                  onBlur={(e) => { if (e.target.value !== (t.notes ?? '')) setTransactionNote(t.id, e.target.value) }} /></td>
              <td className="hide-sm">{t.accountName}</td>
              <td><select value={t.category_id ?? ''} onChange={(e) => (e.target.value === NEW ? openNova({ target: 'row', id: t.id, merchant: t.merchant }) : changeCategory(t, e.target.value))} style={{ maxWidth: 160, fontWeight: t.category_locked ? 600 : 400 }}>
                <option value="">—</option>{sortedCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                <option value={NEW}>+ Nova categoria…</option></select></td>
              <td className={`num ${t.amount < 0 ? 'neg' : 'pos'}`}>{money(t.currency, 2)(t.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
      {rows.length > limit && <button onClick={() => setLimit(limit + 200)}>Mostrar mais</button>}
    </div>
  )
}

/**
 * Spending per category over 1, 6 or 12 months, each category expandable into its
 * merchants. Months well above the usual are red, rows with such a month get a flag,
 * and recurring charges that deserve a look (price up, new, stopped, annual renewal
 * coming) are marked for review.
 */
function Periodo({ ctx, shown, n, onOpen }: { ctx: Ctx; shown: (accountId: string) => boolean; n: number; onOpen: (merchant: string) => void }) {
  const fmt = useFmt(ctx)
  const { data, etx } = ctx
  const subs = useSubscriptions(ctx)
  const [end, setEnd] = useState('') // último mês da janela; vazio = o mais recente com dados
  const [onlyAlerts, setOnlyAlerts] = useState(false)
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const [sortBy, setSortBy] = useState<number | null>(null) // month column to sort by; null = total over the window

  const allMonths = useMemo(() => [...new Set(etx.map((t) => t.month))].sort(), [etx])
  const lastMonth = end || allMonths.at(-1) || ''
  const months = useMemo(() => monthWindow(lastMonth, n), [lastMonth, n])
  const subOf = useMemo(() => new Map(subs.map((s) => [s.merchant, { reason: subscriptionReview(s, today()), active: s.status !== 'possibly_cancelled' }])), [subs])
  const all = useMemo(() => {
    const quiet = <R extends PeriodRow>(r: R): R => ({ ...r, outlier: r.outlier.map(() => false), isNew: r.isNew.map(() => false), flagged: false })
    return buildPeriod(etx.filter((t) => shown(t.account_id)), months)
      .map((g) => (isTithe(g.key) ? { ...quiet(g), merchants: g.merchants.map(quiet) } : g))
  }, [etx, shown, months])
  // Cards are left out of the total: their running sum is not a balance, and the bill is paid from an account shown here.
  const saldos = useMemo(() => monthBalances(
    data.accounts.filter((a) => shown(a.id) && a.type !== 'card'), data.transactions, months,
    (amount, from, date) => ctx.fx.convert(amount, from, ctx.currency, date),
  ), [data.accounts, data.transactions, months, shown, ctx.fx, ctx.currency])

  const needsLook = (m: PeriodRow) => m.flagged || Boolean(subOf.get(m.key)?.reason)
  const col = sortBy !== null && sortBy < months.length ? sortBy : null
  const val = (r: PeriodRow) => (col === null ? r.total : r.perMonth[col] ?? 0)
  const bySort = (a: PeriodRow, b: PeriodRow) => val(b) - val(a)
  const groups = (onlyAlerts
    ? all.map((g) => ({ ...g, merchants: g.merchants.filter(needsLook) })).filter((g) => g.flagged || g.merchants.length)
    : all).map((g) => ({ ...g, merchants: [...g.merchants].sort(bySort) })).sort(bySort)
  const newCount = col === null ? 0 : all.reduce((s, g) => s + g.merchants.filter((m) => m.isNew[col]).length, 0)
  const columnTotals = months.map((_, i) => groups.reduce((s, g) => s + (g.perMonth[i] ?? 0), 0))
  const grand = columnTotals.reduce((s, v) => s + v, 0)
  const toReview = all.reduce((s, g) => s + g.merchants.filter((m) => subOf.get(m.key)?.reason).length, 0)
  const flagged = all.filter((g) => g.flagged).length

  const catIdByName = new Map(data.categories.map((c) => [c.name, c.id]))
  const [saving, setSaving] = useState<string | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  async function moveMerchant(merchant: string, categoryId: string) {
    if (!categoryId) return
    setSaving(merchant); setErro(null)
    try { await setMerchantCategory(data, merchant, categoryId); await ctx.reload() }
    catch (e) { setErro(`Não foi possível mudar a categoria de ${merchant}: ${(e as Error).message}`) }
    finally { setSaving(null) }
  }

  const toggle = (k: string) => setOpen((prev) => { const next = new Set(prev); if (next.has(k)) next.delete(k); else next.add(k); return next })
  const sticky = { position: 'sticky' as const, left: 0, background: 'var(--card)' }

  const cells = (r: PeriodRow) => <>
    {r.perMonth.map((v, i) => (
      <td key={i} className={`num ${r.outlier[i] ? 'neg' : ''} ${r.isNew[i] ? 'novo' : ''}`} style={r.outlier[i] ? { fontWeight: 700 } : undefined}
        title={[r.isNew[i] && 'Novo: nada nos 6 meses anteriores', r.outlier[i] && `Fora do padrão: média ${fmt(r.avg)}`].filter(Boolean).join(' · ') || undefined}>
        {v === null ? <span className="muted">·</span> : fmt(v)}
      </td>
    ))}
    <td className="num muted">{fmt(r.avg)}</td>
    <td className="num"><strong>{fmt(r.total)}</strong></td>
  </>

  if (!months.length) return <div className="card"><p className="muted">Sem lançamentos para comparar.</p></div>

  return (
    <div className="card">
      <div className="row">
        <label className="inline">{n === 1 ? 'Mês' : 'Terminando em'}
          <select value={lastMonth} onChange={(e) => setEnd(e.target.value)}>
            {[...allMonths].reverse().map((m) => <option key={m}>{m}</option>)}
          </select>
        </label>
        <label className="inline"><input type="checkbox" checked={onlyAlerts} onChange={(e) => setOnlyAlerts(e.target.checked)} /> só o que precisa de atenção</label>
        <button onClick={() => setOpen(open.size ? new Set() : new Set(groups.map((g) => g.key)))}>{open.size ? 'Recolher tudo' : 'Expandir tudo'}</button>
      </div>
      <p className="muted">
        Despesas {n === 1 ? `de ${months[0]}` : `de ${months[0]} a ${months.at(-1)}`} · total {fmt(grand)}
        {flagged > 0 && <> · <span className="neg">⚑ {flagged} categoria(s) fora da média</span></>}
        {toReview > 0 && <> · <span className="warn">↻ {toReview} assinatura(s) para revisar</span></>}
        {col !== null && <> · <span style={{ background: 'var(--new)', padding: '0 4px' }}>{newCount} estabelecimento(s) novos em {months[col]}</span></>}
      </p>
      {erro && <p className="err">{erro}</p>}
      <p className="muted" style={{ fontSize: 12 }}>
        Expanda uma categoria (▸) para mudar a categoria de um estabelecimento (vale para todo o histórico dele) ou abrir os lançamentos dele.
        <br /><span className="neg"><strong>Vermelho</strong></span>: mês pelo menos 50% acima da média da linha{n === 1 ? ' (média dos 6 meses anteriores)' : ''}.
        <span style={{ background: 'var(--new)', padding: '0 4px' }}>Amarelo</span>: gasto novo no mês (nada nos 6 meses anteriores).
        Clique num mês para ordenar por ele, ou em Total para voltar. ⚑: linha com algum mês fora da média. ↻: assinatura; <span className="warn">revisar</span> quando o preço subiu, é nova, parou de cobrar ou a renovação anual está perto.
      </p>
      <div className="scroll"><table>
        <thead><tr>
          <th style={sticky}>Categoria / estabelecimento</th><th>Mudar categoria</th>
          {months.map((m, i) => (
            <th key={m} className="num sortable" title="Ordenar por este mês" onClick={() => setSortBy(col === i ? null : i)}>
              {m.slice(2)}{col === i ? ' ▼' : ''}</th>
          ))}
          <th className="num">{n === 1 ? 'Média 6m' : 'Média'}</th>
          <th className="num sortable" title="Ordenar pelo total" onClick={() => setSortBy(null)}>Total{col === null ? ' ▼' : ''}</th>
        </tr>
        <tr className="muted">
          <th style={sticky}>Saldo inicial</th><th />
          {saldos.opening.map((v, i) => <th key={i} className={`num ${v < 0 ? 'neg' : ''}`}>{fmt(v)}</th>)}
          <th /><th />
        </tr></thead>
        <tbody>
          {groups.map((g) => {
            const isOpen = open.has(g.key) || onlyAlerts
            const reviews = g.merchants.filter((m) => subOf.get(m.key)?.reason).length
            return (
              <Fragment key={g.key}>
                <tr>
                  <td style={{ ...sticky, whiteSpace: 'nowrap' }}>
                    <button className="link" onClick={() => toggle(g.key)} aria-expanded={isOpen}>{isOpen ? '▾' : '▸'} {g.key}</button>
                    {g.flagged && <span className="neg" title="Algum mês fora da média"> ⚑</span>}
                    {reviews > 0 && <span className="warn" title="Assinaturas para revisar"> ↻{reviews}</span>}
                  </td>
                  <td />
                  {cells(g)}
                </tr>
                {isOpen && g.merchants.map((m) => {
                  const sub = subOf.get(m.key)
                  return (
                    <tr key={`${g.key}/${m.key}`} className={sub?.active ? 'recorrente' : ''}>
                      <td style={{ ...sticky, whiteSpace: 'nowrap', paddingLeft: 24, fontSize: 13 }}>
                        {sub && <span title="Cobrança recorrente">↻ </span>}{m.key}
                        {m.flagged && <span className="neg" title="Algum mês fora da média"> ⚑</span>}
                        {sub?.reason && <span className="warn" title={sub.reason}> revisar: {sub.reason}</span>}
                        {' '}<button className="link" style={{ fontWeight: 400, fontSize: 12 }} onClick={() => onOpen(m.key)}>ver lançamentos</button>
                      </td>
                      <td style={{ minWidth: 170 }}>
                        <CategorySelect ctx={ctx} value={catIdByName.get(g.key) ?? ''} empty="—" disabled={saving === m.key}
                          label={`Categoria de ${m.key}`} onChange={(id) => moveMerchant(m.key, id)} />
                      </td>
                      {cells(m)}
                    </tr>
                  )
                })}
              </Fragment>
            )
          })}
        </tbody>
        <tfoot><tr>
          <th style={sticky}>Total das despesas</th><th />
          {columnTotals.map((v, i) => <th key={i} className="num">{fmt(v)}</th>)}
          <th /><th className="num">{fmt(grand)}</th>
        </tr>
        <tr>
          <th style={sticky}>Total de entradas</th><th />
          {saldos.inflow.map((v, i) => <th key={i} className="num pos">{fmt(v)}</th>)}
          <th /><th className="num pos">{fmt(saldos.inflow.reduce((s, v) => s + v, 0))}</th>
        </tr>
        <tr>
          <th style={sticky}>Total de saídas</th><th />
          {saldos.outflow.map((v, i) => <th key={i} className="num neg">{fmt(v)}</th>)}
          <th /><th className="num neg">{fmt(saldos.outflow.reduce((s, v) => s + v, 0))}</th>
        </tr>
        <tr>
          <th style={sticky}>Saldo final</th><th />
          {saldos.closing.map((v, i) => <th key={i} className={`num ${v < 0 ? 'neg' : ''}`}>{fmt(v)}</th>)}
          <th /><th />
        </tr></tfoot>
      </table></div>
    </div>
  )
}

/**
 * Money received and spent over the last 24 months, per country of the accounts
 * (Itaú = Brasil, BCP and CCF = França, Millennium = Portugal), for the ticked accounts.
 * Transfers between the user's own accounts and card bill payments are left out.
 */
function PorPais({ ctx, shown }: { ctx: Ctx; shown: (accountId: string) => boolean }) {
  const fmt = useFmt(ctx)
  const { data, etx } = ctx
  const months = useMemo(() => monthWindow(today().slice(0, 7), 24), [])
  const countryOfAccount = useMemo(
    () => new Map(data.accounts.filter((a) => shown(a.id)).map((a) => [a.id, countryOf(a.bank)] as [string, Country])),
    [data.accounts, shown],
  )
  const f = useMemo(() => flowsByCountry(etx, countryOfAccount, months), [etx, countryOfAccount, months])
  const sum = (pick: (c: Country) => number) => f.countries.reduce((s, c) => s + pick(c), 0)
  const all = { income: sum((c) => f.totals(c).income), expense: sum((c) => f.totals(c).expense) }
  const sticky = { position: 'sticky' as const, left: 0, background: 'var(--card)' }

  if (!f.countries.length) return <div className="card"><p className="muted">Nenhum recebimento ou gasto nas contas marcadas nos últimos 24 meses.</p></div>

  return <>
    <div className="card">
      <h3>Recebimentos e gastos por país · {months[0]} a {months.at(-1)}</h3>
      <p className="muted">Contas marcadas acima, em {ctx.currency}. Itaú = Brasil (inclui o cartão), BCP e CCF = França, Millennium = Portugal.
        Transferências entre as suas contas e pagamentos de fatura ficam de fora, para nada contar duas vezes.</p>
      <div className="scroll"><table>
        <thead><tr><th>País</th><th className="num">Recebimentos</th><th className="num">Gastos</th><th className="num">Resultado</th><th className="num">Gasto médio/mês</th></tr></thead>
        <tbody>{f.countries.map((c) => {
          const t = f.totals(c)
          return <tr key={c}><td>{c}</td><td className="num pos">{fmt(t.income)}</td><td className="num neg">{fmt(t.expense)}</td>
            <td className={`num ${t.income - t.expense < 0 ? 'neg' : 'pos'}`}>{fmt(t.income - t.expense)}</td><td className="num">{fmt(t.expense / months.length)}</td></tr>
        })}</tbody>
        <tfoot><tr><th>Total</th><th className="num pos">{fmt(all.income)}</th><th className="num neg">{fmt(all.expense)}</th>
          <th className={`num ${all.income - all.expense < 0 ? 'neg' : 'pos'}`}>{fmt(all.income - all.expense)}</th><th className="num">{fmt(all.expense / months.length)}</th></tr></tfoot>
      </table></div>
    </div>
    <div className="card">
      <h3>Mês a mês</h3>
      <div className="scroll"><table>
        <thead>
          <tr><th style={sticky} rowSpan={2}>Mês</th>
            {f.countries.map((c) => <th key={c} colSpan={2} style={{ textAlign: 'center' }}>{c}</th>)}
            <th colSpan={3} style={{ textAlign: 'center' }}>Total</th></tr>
          <tr>{f.countries.map((c) => <Fragment key={c}><th className="num">Receb.</th><th className="num">Gastos</th></Fragment>)}
            <th className="num">Receb.</th><th className="num">Gastos</th><th className="num">Resultado</th></tr>
        </thead>
        <tbody>{[...months].reverse().map((m) => {
          const inc = sum((c) => f.cell(m, c).income)
          const exp = sum((c) => f.cell(m, c).expense)
          return <tr key={m}><td style={{ ...sticky, whiteSpace: 'nowrap' }}>{m}</td>
            {f.countries.map((c) => <Fragment key={c}>
              <td className="num pos">{f.cell(m, c).income ? fmt(f.cell(m, c).income) : <span className="muted">·</span>}</td>
              <td className="num neg">{f.cell(m, c).expense ? fmt(f.cell(m, c).expense) : <span className="muted">·</span>}</td>
            </Fragment>)}
            <td className="num pos">{fmt(inc)}</td><td className="num neg">{fmt(exp)}</td>
            <td className={`num ${inc - exp < 0 ? 'neg' : 'pos'}`}><strong>{fmt(inc - exp)}</strong></td></tr>
        })}</tbody>
      </table></div>
    </div>
  </>
}
