import type { ReactNode } from 'react'
import { Icon } from './Icons'

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
