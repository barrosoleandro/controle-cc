import { useEffect, useRef, useState, type ReactNode } from 'react'
import { pctChange, type Measure } from '../../domain/explore'
import { pct } from './util'

/**
 * Change against the comparison period, with an arrow and a sign so it never rests on color.
 * For spending a rise is bad; for income a rise is good. Tithe rows stay neutral: the app
 * does not comment on them.
 */
export function Delta({ cur, prev, measure, neutral, money }: { cur: number; prev: number | null; measure: Measure; neutral?: boolean; money?: (n: number) => string }) {
  if (prev === null) return null
  const p = pctChange(cur, prev)
  const d = cur - prev
  if (Math.abs(d) < 0.5) return <span className="muted">= igual</span>
  const up = d > 0
  const good = measure === 'income' ? up : !up
  const cls = neutral ? 'muted' : good ? 'pos' : 'neg'
  const txt = p === null ? 'novo' : `${up ? '+' : '−'}${pct(Math.abs(p))}`
  return <span className={cls} title={money ? `${up ? '+' : '−'}${money(Math.abs(d))} contra o período de comparação` : undefined}>{up ? '▲' : '▼'} {txt}</span>
}

export function Kpi({ label, value, sub, cls }: { label: string; value: ReactNode; sub?: ReactNode; cls?: string }) {
  return (
    <div className="kpi">
      <div className="l">{label}</div>
      <div className={`v ${cls ?? ''}`}>{value}</div>
      {sub !== undefined && <div className="d">{sub}</div>}
    </div>
  )
}

/** Tiny trend line for a table row (one series, no axes; the numbers are in the row). */
export function Spark({ values, color = 'var(--s1)', w = 96, h = 24 }: { values: number[]; color?: string; w?: number; h?: number }) {
  if (values.length < 2) return null
  const max = Math.max(...values, 0), min = Math.min(...values, 0)
  const span = max - min || 1
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * (w - 4) + 2},${h - 2 - ((v - min) / span) * (h - 4)}`)
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={pts.at(-1)!.split(',')[0]} cy={pts.at(-1)!.split(',')[1]} r={2} fill={color} />
    </svg>
  )
}

export const Swatch = ({ color }: { color: string }) => <span className="swatch" style={{ background: color }} />

/** Dropdown that closes on a click outside or Escape. */
export function Menu({ label, children, active, align }: { label: ReactNode; children: ReactNode; active?: boolean; align?: 'right' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const out = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', out)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('pointerdown', out); document.removeEventListener('keydown', esc) }
  }, [open])
  return (
    <div className="menu" ref={ref}>
      <button className={active ? 'active' : ''} aria-expanded={open} onClick={() => setOpen(!open)}>{label} ▾</button>
      {open && <div className={`pop ${align === 'right' ? 'right' : ''}`}>{children}</div>}
    </div>
  )
}

