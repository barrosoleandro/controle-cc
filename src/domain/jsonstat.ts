/**
 * Minimal reader for JSON-stat 2.0, the format Eurostat answers in.
 *
 * Values arrive flattened into a single index and sparse: a cell that is confidential or
 * not published is simply absent, never zero. So a reader must resolve coordinates through
 * each dimension's own index and skip what is missing — reading by array position silently
 * shifts every figure when one cell is withheld.
 */

export interface JsonStat {
  label?: string
  updated?: string
  id?: string[]
  size?: number[]
  value?: Record<string, number | null> | (number | null)[]
  dimension?: Record<string, { label?: string; category?: { index?: Record<string, number>; label?: Record<string, string> } }>
}

/** One published cell: the category code picked on each dimension, plus the number. */
export interface Cell {
  coords: Record<string, string>
  value: number
}

/** Category codes of a dimension, in the order the answer declares them. */
export function categories(body: JsonStat, dim: string): string[] {
  const index = body.dimension?.[dim]?.category?.index
  if (!index) return []
  return Object.entries(index).sort((a, b) => a[1] - b[1]).map(([code]) => code)
}

export const categoryLabel = (body: JsonStat, dim: string, code: string) =>
  body.dimension?.[dim]?.category?.label?.[code] ?? code

/**
 * Every published cell, with its coordinates resolved to category codes.
 * Flat index = sum over dimensions of (position × product of the sizes that follow it).
 */
export function cells(body: JsonStat): Cell[] {
  const ids = body.id ?? []
  const sizes = body.size ?? []
  if (!ids.length || ids.length !== sizes.length) throw new Error('Resposta sem as dimensões (id/size) do JSON-stat.')

  // Category code per dimension, by position.
  const codes = ids.map((d) => categories(body, d))
  if (codes.some((c, i) => c.length !== sizes[i])) throw new Error('Dimensão do JSON-stat com tamanho que não bate com as categorias.')

  const strides = sizes.map((_, i) => sizes.slice(i + 1).reduce((a, b) => a * b, 1))
  const total = sizes.reduce((a, b) => a * b, 1)
  const at = (i: number) => (Array.isArray(body.value) ? body.value[i] : body.value?.[String(i)])

  const out: Cell[] = []
  for (let flat = 0; flat < total; flat++) {
    const v = at(flat)
    if (typeof v !== 'number' || !Number.isFinite(v)) continue // absent, null or withheld
    const coords: Record<string, string> = {}
    for (let d = 0; d < ids.length; d++) coords[ids[d]] = codes[d][Math.floor(flat / strides[d]) % sizes[d]]
    out.push({ coords, value: v })
  }
  return out
}

/** The one cell matching `pick`, or null. Throws if the pick is ambiguous. */
export function cell(body: JsonStat, pick: Record<string, string>): Cell | null {
  const found = cells(body).filter((c) => Object.entries(pick).every(([d, v]) => c.coords[d] === v))
  if (found.length > 1) throw new Error('A seleção casa com mais de um valor; refine as dimensões.')
  return found[0] ?? null
}
