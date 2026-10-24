import type { ReactNode } from 'react'
import { Icon } from './Icons'
import type { AppData } from '../lib/data'
import { positionDates, today } from '../lib/hooks'

const STALE_DAYS = 7
const dateBR = (iso: string) => iso.split('-').reverse().join('/')

/**
 * "Posição em 22/10/2026": how recent the numbers on screen are, for the accounts shown.
 * With several accounts it is the oldest of them (the view is only as current as that one),
 * each account's own date in the tooltip. A week old or more, it says so and offers Importar.
 */
export function AsOf({ data, ids, onImport }: { data: AppData; ids: Iterable<string>; onImport?: () => void }) {
  const each = positionDates(data, ids)
  const known = each.filter((e) => e.date).map((e) => e.date!).sort()
  if (!each.length) return null
  const oldest = known[0]
  const days = oldest ? Math.round((Date.parse(today()) - Date.parse(oldest)) / 86400000) : null
  const stale = days === null || days >= STALE_DAYS
  const tip = each.map((e) => `${e.account.name}: ${e.date ? dateBR(e.date) : 'sem dados'}`).join('\n')
  return (
    <span className={`asof ${stale ? 'stale' : ''}`} title={tip}>
      <Icon name="calendario" size={15} />
      {oldest ? <>Posição em <strong>{dateBR(oldest)}</strong></> : 'Sem dados'}
      {each.length > 1 && known.length > 0 && <span className="asof-n">· {each.length} contas</span>}
      {stale && days !== null && <span>· há {days} dias</span>}
      {stale && onImport && <button className="link" onClick={onImport}>atualizar</button>}
    </span>
  )
}

/** The long "how this works" notes: one line on the screen, the text only when asked for. */
export function Help({ title = 'Como funciona', children }: { title?: string; children: ReactNode }) {
  return (
    <details className="help">
      <summary><Icon name="ajuda" size={15} />{title}</summary>
      <div>{children}</div>
    </details>
  )
}

/** Sub-sections of a page, as underlined tabs: the same control on every page. */
export function Tabs<T extends string>({ items, value, onChange, label }: { items: readonly (T | readonly [T, string])[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <nav className="tabs" aria-label={label}>
      {items.map((it) => {
        const [id, text] = typeof it === 'string' ? [it, it] : it
        return <button key={id} className={value === id ? 'on' : ''} aria-current={value === id ? 'page' : undefined} onClick={() => onChange(id)}>{text}</button>
      })}
    </nav>
  )
}

/** A headline number: icon, label, value and an optional line under it. */
export function Stat({ icon, label, value, sub, tone, children }: {
  icon?: Parameters<typeof Icon>[0]['name']; label: ReactNode; value: ReactNode; sub?: ReactNode
  tone?: 'accent' | 'pos' | 'neg' | 'neutral'; children?: ReactNode
}) {
  return (
    <div className={`stat ${tone ? `t-${tone}` : ''}`}>
      <div className="stat-head">
        {icon && <span className="stat-icon"><Icon name={icon} size={18} /></span>}
        <span className="stat-label">{label}</span>
      </div>
      <div className="stat-value">{value}</div>
      {sub !== undefined && <div className="stat-sub">{sub}</div>}
      {children}
    </div>
  )
}

/** Shown while a page has nothing to show yet, with the one action that fills it. */
export function Empty({ icon, title, children, action }: { icon: Parameters<typeof Icon>[0]['name']; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="card empty">
      <span className="empty-icon"><Icon name={icon} size={28} /></span>
      <h3>{title}</h3>
      {children && <p className="muted">{children}</p>}
      {action}
    </div>
  )
}
