import { useState, type CSSProperties } from 'react'
import type { Ctx } from '../App'
import { addCategory } from '../lib/data'
import { byName } from '../domain/categorize'
import type { CategoryKind } from '../domain/types'

const TIPO: Record<CategoryKind, string> = { expense: 'despesa', income: 'receita', transfer: 'transferência' }
const NEW = '__new'

interface Props {
  ctx: Ctx
  value: string
  onChange: (categoryId: string) => void | Promise<void>
  /** Label of the empty option; leave out when a category is mandatory. */
  empty?: string
  disabled?: boolean
  style?: CSSProperties
  label?: string
}

/**
 * The one category picker: always alphabetical, and "+ Nova categoria…" turns it into a
 * small form that creates the category (or reuses one with the same name) and selects it.
 */
export function CategorySelect({ ctx, value, onChange, empty, disabled, style, label }: Props) {
  const [creating, setCreating] = useState(false)
  const [nome, setNome] = useState('')
  const [tipo, setTipo] = useState<CategoryKind>('expense')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cats = [...ctx.data.categories].sort(byName)

  async function criar() {
    const limpo = nome.trim()
    if (!limpo) return
    setBusy(true); setError(null)
    try {
      const repetida = ctx.data.categories.find((c) => c.name.toLowerCase() === limpo.toLowerCase())
      const criada = repetida ?? (await addCategory(limpo, tipo, '#888888', ctx.data.categories.length))
      setCreating(false); setNome('')
      await onChange(criada.id)
      await ctx.reload()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  if (creating) {
    return (
      <div className="row" style={{ marginBottom: 0 }}>
        <input placeholder="Nome da categoria" value={nome} onChange={(e) => setNome(e.target.value)} disabled={busy} autoFocus
          onKeyDown={(e) => { if (e.key === 'Enter') criar(); if (e.key === 'Escape') setCreating(false) }} />
        <select value={tipo} onChange={(e) => setTipo(e.target.value as CategoryKind)} disabled={busy} aria-label="Tipo da categoria">
          {(Object.keys(TIPO) as CategoryKind[]).map((k) => <option key={k} value={k}>{TIPO[k]}</option>)}
        </select>
        <button className="primary" onClick={criar} disabled={busy || !nome.trim()}>Criar</button>
        <button onClick={() => setCreating(false)} disabled={busy}>Cancelar</button>
        {error && <span className="err">{error}</span>}
      </div>
    )
  }

  return (
    <select value={value} disabled={disabled} style={style} aria-label={label}
      onChange={(e) => { if (e.target.value === NEW) { setCreating(true); setTipo('expense') } else onChange(e.target.value) }}>
      {empty !== undefined && <option value="">{empty}</option>}
      {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      <option value={NEW}>+ Nova categoria…</option>
    </select>
  )
}
