import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Ctx } from '../App'
import { monthLabel } from '../lib/format'
import { today, useFmt } from '../lib/hooks'
import { byName } from '../domain/categorize'
import { countryOf } from '../domain/countries'
import { addDays, addMonths, compareRange, daysIn, fold, lastDayOf, monthRange, monthsOf, rankCategories, select, type CompareMode, type Filter, type Measure, type Range } from '../domain/explore'
import { Menu, Swatch } from './analysis/shared'
import { fullDate, OTHER_COLOR, type ViewProps } from './analysis/util'
import { Overview } from './analysis/Overview'
import { TrendView } from './analysis/TrendView'
import { CategoriesView } from './analysis/CategoriesView'
import { MerchantsView } from './analysis/MerchantsView'
import { DatesView } from './analysis/DatesView'
import { RowsView } from './analysis/RowsView'

const VIEWS = [
  ['geral', 'Visão geral'], ['tendencia', 'Tendência'], ['categorias', 'Categorias'],
  ['estab', 'Estabelecimentos'], ['datas', 'Datas'], ['lista', 'Lançamentos'],
] as const
type View = (typeof VIEWS)[number][0]
type Preset = 'm1' | 'm3' | 'm6' | 'm12' | 'ytd' | 'py' | 'all' | 'custom'
const COMPARE: [CompareMode, string][] = [['prev', 'Período anterior'], ['yoy', 'Mesmo período do ano anterior'], ['none', 'Sem comparação']]

interface State {
  preset: Preset; from: string; to: string; compare: CompareMode; measure: Measure
  hidden: string[]; categories: string[]; search: string; min: number; view: View
}
const DEFAULTS: State = { preset: 'm6', from: '', to: '', compare: 'prev', measure: 'expense', hidden: [], categories: [], search: '', min: 0, view: 'geral' }
const KEY = 'analysis'
const load = (): State => { try { return { ...DEFAULTS, ...JSON.parse(sessionStorage.getItem(KEY) ?? '{}') } } catch { return DEFAULTS } }

/** A range moved one step back or forward: by its months when it is whole months, else by its days. */
function step(r: Range, dir: 1 | -1): Range {
  const whole = r.from.endsWith('-01') && r.to === lastDayOf(r.to.slice(0, 7))
  if (whole) { const n = monthsOf(r).length * dir; return monthRange(addMonths(r.from.slice(0, 7), n), addMonths(r.to.slice(0, 7), n)) }
  const n = daysIn(r) * dir
  return { from: addDays(r.from, n), to: addDays(r.to, n) }
}

const rangeLabel = (r: Range) => {
  const whole = r.from.endsWith('-01') && r.to === lastDayOf(r.to.slice(0, 7))
  if (!whole) return `${fullDate(r.from)} – ${fullDate(r.to)}`
  const a = r.from.slice(0, 7), b = r.to.slice(0, 7)
  return a === b ? monthLabel(a) : `${monthLabel(a)} – ${monthLabel(b)}`
}

export function Analysis({ ctx }: { ctx: Ctx }) {
  const fmt = useFmt(ctx)
  const { data, etx } = ctx
  const [st, setSt] = useState<State>(load)
  const set = (patch: Partial<State>) => setSt((s) => ({ ...s, ...patch }))
  useEffect(() => { try { sessionStorage.setItem(KEY, JSON.stringify(st)) } catch { /* private mode: filters just reset */ } }, [st])
  const [focusCat, setFocusCat] = useState('')
  const [focusMerchant, setFocusMerchant] = useState('')

  // Presets end at the latest month that already happened (card instalments can be dated ahead).
  const months = useMemo(() => [...new Set(etx.map((t) => t.month))].sort(), [etx])
  const thisMonth = today().slice(0, 7)
  const lastReal = [...months].reverse().find((m) => m <= thisMonth) ?? months.at(-1) ?? thisMonth
  const firstMonth = months[0] ?? lastReal
  const year = lastReal.slice(0, 4)
  const presets: [Preset, string, Range][] = [
    ['m1', `Último mês (${monthLabel(lastReal)})`, monthRange(lastReal, lastReal)],
    ['m3', 'Últimos 3 meses', monthRange(addMonths(lastReal, -2), lastReal)],
    ['m6', 'Últimos 6 meses', monthRange(addMonths(lastReal, -5), lastReal)],
    ['m12', 'Últimos 12 meses', monthRange(addMonths(lastReal, -11), lastReal)],
    ['ytd', `Ano de ${year}`, monthRange(`${year}-01`, lastReal)],
    ['py', `Ano de ${Number(year) - 1}`, monthRange(`${Number(year) - 1}-01`, `${Number(year) - 1}-12`)],
    ['all', 'Todo o histórico', monthRange(firstMonth, lastReal)],
  ]
  const range: Range = st.preset === 'custom' && st.from && st.to && st.from <= st.to ? { from: st.from, to: st.to } : (presets.find((x) => x[0] === st.preset) ?? presets[2])[2]
  const prevRange = compareRange(range, st.compare)
  const periodMonths = useMemo(() => monthsOf(range), [range.from, range.to]) // eslint-disable-line react-hooks/exhaustive-deps

  // Accounts: a card with a paying account follows it (ticking Itaú Conta brings the Itaú card's purchases).
  const payerOf = useMemo(() => new Map(data.accounts.filter((a) => a.type === 'card' && a.parent_account_id).map((a) => [a.id, a.parent_account_id!])), [data.accounts])
  const listed = data.accounts.filter((a) => !payerOf.has(a.id))
  const hidden = useMemo(() => new Set(st.hidden), [st.hidden])
  const inScope = useCallback((id: string) => !hidden.has(payerOf.get(id) ?? id), [hidden, payerOf])

  const filter: Filter = useMemo(() => ({ measure: st.measure, categories: st.categories, search: st.search, min: st.min }), [st.measure, st.categories, st.search, st.min])
  const rows = useMemo(() => select(etx, range, filter, inScope), [etx, range.from, range.to, filter, inScope]) // eslint-disable-line react-hooks/exhaustive-deps
  const prevRows = useMemo(() => (prevRange ? select(etx, prevRange, filter, inScope) : []), [etx, prevRange?.from, prevRange?.to, filter, inScope]) // eslint-disable-line react-hooks/exhaustive-deps
  const hist = useMemo(() => select(etx, null, filter, inScope), [etx, filter, inScope])

  // Colors stay with the category: the seven biggest of all time keep theirs whatever the filter.
  const rank = useMemo(() => rankCategories(etx, st.measure).slice(0, 7), [etx, st.measure])
  const colorOf = useCallback((c: string) => { const i = rank.indexOf(c); return i < 0 ? OTHER_COLOR : `var(--s${i + 1})` }, [rank])

  const catNames = useMemo(() => [...new Set([
    ...data.categories.filter((c) => c.kind === st.measure).map((c) => c.name),
    ...etx.filter((t) => t.kind === st.measure).map((t) => t.categoryName),
  ])].map((name) => ({ name })).sort(byName).map((c) => c.name), [data.categories, etx, st.measure])
  const merchantNames = useMemo(() => [...new Set(etx.filter((t) => t.kind === st.measure).map((t) => t.merchant))].sort().slice(0, 3000), [etx, st.measure])
  const [catQ, setCatQ] = useState('')

  if (!etx.length) return <div className="card"><p className="muted">Importe extratos para começar as análises.</p></div>

  const unfiltered = !st.categories.length && !st.search && !st.min
  const toggleCat = (c: string) => set({ categories: st.categories.includes(c) ? st.categories.filter((x) => x !== c) : [...st.categories, c] })
  const toggleAcc = (id: string) => set({ hidden: hidden.has(id) ? st.hidden.filter((x) => x !== id) : [...st.hidden, id] })
  const shownCount = listed.filter((a) => !hidden.has(a.id)).length
  const countries = [...new Set(listed.map((a) => countryOf(a.bank)))]

  const props: ViewProps = {
    ctx, fmt, measure: st.measure, range, prevRange, months: periodMonths, rows, prevRows, hist, colorOf, unfiltered, inScope,
    onCategory: (c) => { setFocusCat(c); set({ view: 'categorias' }) },
    onMerchant: (m) => { setFocusMerchant(m); set({ view: 'estab' }) },
    filterCategory: (c) => set({ categories: [c] }),
    filterMerchant: (m) => set({ search: m }),
    focus: st.view === 'categorias' ? focusCat : focusMerchant,
    setFocus: st.view === 'categorias' ? setFocusCat : setFocusMerchant,
  }

  return (
    <>
      {/* One row of filters: they scope every view below, so the numbers always agree. */}
      <div className="filters">
        <div className="seg" role="group" aria-label="O que analisar">
          {([['expense', 'Gastos'], ['income', 'Receitas']] as [Measure, string][]).map(([m, l]) => (
            <button key={m} className={st.measure === m ? 'on' : ''} aria-pressed={st.measure === m} onClick={() => { set({ measure: m, categories: [] }); setFocusCat('') }}>{l}</button>
          ))}
        </div>
        <div className="stepper">
          <button aria-label="Período anterior" onClick={() => { const r = step(range, -1); set({ preset: 'custom', ...r }) }}>‹</button>
          <Menu label={<>📅 {rangeLabel(range)}</>}>
            <div className="presets">
              {presets.map(([id, label]) => (
                <button key={id} className={st.preset === id ? 'on' : ''} onClick={() => set({ preset: id })}>
                  <span className="check">{st.preset === id ? '✓' : ''}</span>{label}
                </button>
              ))}
            </div>
            <div className="custom">
              <strong>Personalizado</strong>
              <label>De <input type="date" value={range.from} onChange={(e) => e.target.value && set({ preset: 'custom', from: e.target.value, to: range.to })} /></label>
              <label>Até <input type="date" value={range.to} onChange={(e) => e.target.value && set({ preset: 'custom', from: range.from, to: e.target.value })} /></label>
            </div>
          </Menu>
          <button aria-label="Período seguinte" onClick={() => { const r = step(range, 1); set({ preset: 'custom', ...r }) }}>›</button>
        </div>
        <label className="inline muted">vs
          <select value={st.compare} onChange={(e) => set({ compare: e.target.value as CompareMode })} aria-label="Comparar com">
            {COMPARE.map(([id, l]) => <option key={id} value={id}>{l}</option>)}
          </select>
        </label>
        <Menu label={`Contas: ${shownCount === listed.length ? 'todas' : `${shownCount} de ${listed.length}`}`} active={shownCount !== listed.length}>
          <div className="row" style={{ marginBottom: 8 }}>
            {countries.map((c) => <button key={c} onClick={() => set({ hidden: listed.filter((a) => countryOf(a.bank) !== c).map((a) => a.id) })}>{c}</button>)}
            <button onClick={() => set({ hidden: [] })}>Todas</button>
          </div>
          {listed.map((a) => (
            <label key={a.id} className="inline opt"><input type="checkbox" checked={!hidden.has(a.id)} onChange={() => toggleAcc(a.id)} />{a.name}
              {data.accounts.some((c) => payerOf.get(c.id) === a.id) && <span className="muted" style={{ fontSize: 12 }}>+ cartão</span>}</label>
          ))}
        </Menu>
        <Menu label={`Categorias: ${st.categories.length === 0 ? 'todas' : st.categories.length === 1 ? st.categories[0] : st.categories.length}`} active={st.categories.length > 0}>
          <input type="search" placeholder="Procurar categoria" value={catQ} onChange={(e) => setCatQ(e.target.value)} style={{ width: '100%', marginBottom: 6 }} />
          <div className="row" style={{ marginBottom: 6 }}><button onClick={() => set({ categories: [] })}>Todas</button></div>
          <div className="opts">
            {catNames.filter((c) => !catQ || fold(c).includes(fold(catQ))).map((c) => (
              <label key={c} className="inline opt"><input type="checkbox" checked={st.categories.includes(c)} onChange={() => toggleCat(c)} /><Swatch color={colorOf(c)} />{c}</label>
            ))}
          </div>
        </Menu>
        <input type="search" list="an-merchants" placeholder="Estabelecimento ou descrição" value={st.search} onChange={(e) => set({ search: e.target.value })} aria-label="Procurar estabelecimento ou descrição" className="grow" />
        <datalist id="an-merchants">{merchantNames.map((m) => <option key={m} value={m} />)}</datalist>
        <input type="number" min={0} step={10} placeholder="Valor mín." value={st.min || ''} onChange={(e) => set({ min: Math.max(0, Number(e.target.value) || 0) })} aria-label="Valor mínimo" style={{ width: 110 }} />
      </div>

      <div className="chips">
        <span className="muted" style={{ fontSize: 13 }}>
          {st.measure === 'expense' ? 'Gastos' : 'Receitas'} · {rangeLabel(range)}{prevRange ? ` · comparado com ${rangeLabel(prevRange)}` : ''} · transferências entre contas ficam de fora
        </span>
        {st.categories.map((c) => <span key={c} className="chip">{c}<button aria-label={`Tirar ${c}`} onClick={() => toggleCat(c)}>✕</button></span>)}
        {st.search && <span className="chip">contém "{st.search}"<button aria-label="Tirar busca" onClick={() => set({ search: '' })}>✕</button></span>}
        {st.min > 0 && <span className="chip">a partir de {fmt(st.min)}<button aria-label="Tirar valor mínimo" onClick={() => set({ min: 0 })}>✕</button></span>}
        {shownCount !== listed.length && <span className="chip">{shownCount} de {listed.length} contas<button aria-label="Todas as contas" onClick={() => set({ hidden: [] })}>✕</button></span>}
        {(!unfiltered || shownCount !== listed.length) && <button className="link" onClick={() => set({ categories: [], search: '', min: 0, hidden: [] })}>Limpar filtros</button>}
      </div>

      <nav className="tabs" aria-label="Análises">
        {VIEWS.map(([id, label]) => (
          <button key={id} className={st.view === id ? 'on' : ''} aria-current={st.view === id ? 'page' : undefined} onClick={() => set({ view: id })}>{label}</button>
        ))}
      </nav>

      {st.view === 'geral' && <Overview {...props} key={`${range.from}${range.to}`} />}
      {st.view === 'tendencia' && <TrendView {...props} />}
      {st.view === 'categorias' && <CategoriesView {...props} />}
      {st.view === 'estab' && <MerchantsView {...props} />}
      {st.view === 'datas' && <DatesView {...props} />}
      {st.view === 'lista' && <RowsView {...props} />}
    </>
  )
}
