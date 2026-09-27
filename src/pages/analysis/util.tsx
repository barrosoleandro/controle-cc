import { useMemo, useState, type ReactNode } from 'react'
import type { Ctx } from '../../App'
import type { EnrichedTx } from '../../domain/analytics'
import { daysIn, type Grain, type Group, type Measure, type Range, type Row } from '../../domain/explore'
import { isTithe } from '../../domain/categorize'
import { monthLabel } from '../../lib/format'

export type ARow = Row<EnrichedTx>

/** What every view of the Análises page gets: the same slice, so the numbers always agree. */
export interface ViewProps {
  ctx: Ctx
  fmt: (n: number) => string
  measure: Measure
  range: Range
  prevRange: Range | null
  months: string[] // calendar months of the range
  rows: ARow[] // the slice
  prevRows: ARow[] // the same filter over the comparison period (empty without one)
  hist: ARow[] // the same filter over every date
  colorOf: (category: string) => string
  onCategory: (name: string) => void // open the category's detail
  onMerchant: (merchant: string) => void // open the merchant's detail
  filterCategory: (name: string) => void // narrow the whole page to one category
  filterMerchant: (merchant: string) => void // narrow the whole page to one merchant
  focus: string // category or merchant whose detail is open in this view
  setFocus: (key: string) => void
  unfiltered: boolean // no category, text or minimum filter: income vs spending can be shown
  inScope: (accountId: string) => boolean
}

export const WEEKDAYS = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom']
export const dayLabel = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`
export const fullDate = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(2, 4)}`
export const pct = (x: number, digits = 0) => `${(x * 100).toLocaleString('pt-BR', { maximumFractionDigits: digits })}%`
export const noun = (measure: Measure) => (measure === 'expense' ? 'Gastos' : 'Receitas')

export const neutralFor = (category: string) => isTithe(category)

/** Sortable table state: click a header to sort by it, again to flip the order. */
export function useSort<T>(rows: T[], initial: keyof T & string, get: (r: T, k: string) => number | string = (r, k) => r[k as keyof T] as number | string) {
  const [key, setKey] = useState<string>(initial)
  const [desc, setDesc] = useState(true)
  const sorted = useMemo(() => [...rows].sort((a, b) => {
    const x = get(a, key), y = get(b, key)
    const c = typeof x === 'string' ? x.localeCompare(String(y), 'pt-BR') : x - (y as number)
    return desc ? -c : c
  }), [rows, key, desc]) // eslint-disable-line react-hooks/exhaustive-deps
  const Th = ({ k, children, num }: { k: string; children: ReactNode; num?: boolean }) => (
    <th className={`sortable ${num ? 'num' : ''}`} aria-sort={key === k ? (desc ? 'descending' : 'ascending') : undefined}
      onClick={() => { if (key === k) setDesc(!desc); else { setKey(k); setDesc(true) } }}>
      {children}{key === k ? (desc ? ' ↓' : ' ↑') : ''}
    </th>
  )
  return { sorted, Th }
}

/** Every: "a cada 7 dias" from the median gap between charges. */
export const cadence = (every: number | null) => {
  if (every === null) return '—'
  if (every <= 1) return 'diária'
  if (every >= 26 && every <= 35) return 'mensal'
  if (every >= 6 && every <= 8) return 'semanal'
  return `a cada ${Math.round(every)} dias`
}

/** Top `n` groups plus one "Outros" holding the rest. */
export function topWithOther(groups: Group[], n: number): { key: string; total: number; other?: boolean }[] {
  if (groups.length <= n + 1) return groups
  const rest = groups.slice(n).reduce((s, g) => s + g.total, 0)
  return [...groups.slice(0, n), { key: `Outros (${groups.length - n})`, total: rest, other: true }]
}

export const OTHER_COLOR = 'var(--s-other)'

export const defaultGrain = (r: Range): Grain => (daysIn(r) <= 62 ? 'day' : 'month')
export const bucketLabel = (k: string, g: Grain) => (g === 'month' ? monthLabel(k) : g === 'week' ? `sem ${dayLabel(k)}` : dayLabel(k))

/** Up to seven categories keep their own color; the rest fold into "Outros". */
export function seriesKeyOf(colorOf: (c: string) => string) {
  return (c: string) => (colorOf(c) === OTHER_COLOR ? 'Outros' : c)
}
