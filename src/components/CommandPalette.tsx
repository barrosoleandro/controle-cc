import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from './Icons'
import { PAGES, SECTIONS, TABS, fold, type Tab } from '../lib/nav'

interface Item { key: string; tab: Tab; sub?: string; title: string; hint: string; words: string }

/**
 * "Ir para…": every page and the sections inside them, found by typing a few letters
 * (accents and case ignored). Opens from the search button or Ctrl/⌘+K.
 */
export function CommandPalette({ onGo, onClose }: { onGo: (tab: Tab, sub?: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const items = useMemo<Item[]>(() => [
    ...TABS.map((t) => ({ key: t, tab: t, title: t, hint: PAGES[t].desc, words: fold(`${t} ${PAGES[t].desc}`) })),
    ...SECTIONS.map((s) => ({ key: `${s.tab}/${s.sub}`, tab: s.tab, sub: s.sub, title: s.label, hint: s.tab, words: fold(`${s.label} ${s.tab} ${s.keywords ?? ''}`) })),
  ], [])
  const found = useMemo(() => {
    const terms = fold(q).split(/\s+/).filter(Boolean)
    return terms.length ? items.filter((i) => terms.every((w) => i.words.includes(w))) : items.filter((i) => !i.sub)
  }, [items, q])
  useEffect(() => { listRef.current?.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' }) }, [at])

  const pick = (i: Item | undefined) => { if (i) onGo(i.tab, i.sub) }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setAt((a) => Math.min(found.length - 1, a + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((a) => Math.max(0, a - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); pick(found[at]) }
    else if (e.key === 'Escape') onClose()
  }

  return (
    <div className="palette-backdrop" onPointerDown={onClose}>
      <div className="palette" role="dialog" aria-label="Ir para" onPointerDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Icon name="busca" size={18} />
          <input autoFocus placeholder="Ir para… (ex.: orçamento, regras, fatura)" value={q} onChange={(e) => { setQ(e.target.value); setAt(0) }} onKeyDown={onKey}
            role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={found[at] ? `pal-${found[at].key}` : undefined} />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {found.length === 0 && <p className="muted palette-empty">Nada encontrado para “{q}”.</p>}
          {found.map((i, n) => (
            <button key={i.key} id={`pal-${i.key}`} role="option" aria-selected={n === at} className={n === at ? 'on' : ''}
              onPointerEnter={() => setAt(n)} onClick={() => pick(i)}>
              <span className="palette-icon"><Icon name={PAGES[i.tab].icon} size={18} /></span>
              <span className="palette-text"><strong>{i.title}</strong><span>{i.hint}</span></span>
              <Icon name="seta" size={16} />
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
