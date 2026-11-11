import type { ReactNode } from 'react'
import type { Account } from '../domain/types'
import { countryOf } from '../domain/countries'
import { Menu } from '../pages/analysis/shared'

/**
 * The account filter of every page: tick the accounts to show, or pick a country / all of them.
 * `hidden` holds the unticked ids. `compact` words the button for a toolbar with other filters
 * ("Contas: todas"); otherwise it names the single ticked account.
 */
export function AccountMenu({ accounts, hidden, onChange, align, compact, note }: {
  accounts: Account[]
  hidden: Set<string>
  onChange: (hidden: Set<string>) => void
  align?: 'right'
  compact?: boolean
  /** Extra text after an account's name (e.g. "+ cartão"). */
  note?: (a: Account) => ReactNode
}) {
  const shown = accounts.filter((a) => !hidden.has(a.id))
  const all = shown.length === accounts.length
  const count = `${shown.length} de ${accounts.length}`
  const label = compact ? `Contas: ${all ? 'todas' : count}`
    : all ? 'Todas as contas' : shown.length === 1 ? shown[0].name : `${count} contas`
  const countries = [...new Set(accounts.map((a) => countryOf(a.bank)))]
  const toggle = (id: string) => { const next = new Set(hidden); if (!next.delete(id)) next.add(id); onChange(next) }
  return (
    <Menu align={align} active={!all} label={label}>
      <div className="row" style={{ marginBottom: 8 }}>
        {countries.map((c) => <button key={c} onClick={() => onChange(new Set(accounts.filter((a) => countryOf(a.bank) !== c).map((a) => a.id)))}>{c}</button>)}
        <button onClick={() => onChange(new Set())}>Todas</button>
      </div>
      <div className="opts">
        {accounts.map((a) => (
          <label key={a.id} className="inline opt"><input type="checkbox" checked={!hidden.has(a.id)} onChange={() => toggle(a.id)} />{a.name}
            {' '}<span className="muted" style={{ fontSize: 12 }}>· {countryOf(a.bank)}</span>{note?.(a)}</label>
        ))}
      </div>
    </Menu>
  )
}
