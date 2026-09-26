import type { Category, CategoryKind } from './types'

/** A category that absorbs others. Names used by the code ("Transfer", "Salario", "Outros"…) stay as they are. */
export interface MergeGroup { target: string; kind: CategoryKind; sources: string[]; note?: string }

/** The suggested simplification: ~20 categories instead of ~50. Merchants still show inside each one. */
export const SIMPLIFICATION: MergeGroup[] = [
  { target: 'Moradia', kind: 'expense', sources: ['Aluguel', 'Engie', 'Free'] },
  { target: 'Mercado', kind: 'expense', sources: ['Mercado', 'Picard', 'Padaria', 'Torta'], note: 'Torta: confirme se é comida' },
  { target: 'Restaurantes', kind: 'expense', sources: ['Restaurante', 'Sodexo'] },
  { target: 'Transporte', kind: 'expense', sources: ['Transporte', 'Combustivel', 'C3'] },
  { target: 'Saúde e bem-estar', kind: 'expense', sources: ['Saúde', 'Dentista', 'Academia', 'Salao', 'Aquasport'] },
  { target: 'Educação', kind: 'expense', sources: ['Educação', 'AulaFlauta', 'AulaSax', 'Preply', 'Instrumentos'] },
  { target: 'Lazer e assinaturas', kind: 'expense', sources: ['Lazer', 'Cultura', 'Streaming'] },
  { target: 'Compras', kind: 'expense', sources: ['Compras', 'Compras online', 'Roupas', 'Dry cleaning'] },
  { target: 'Impostos, seguros e tarifas', kind: 'expense', sources: ['Impostos e taxas', 'Seguros', 'AXA - Seg. Carol', 'Conta'] },
  { target: 'Doações e dízimo', kind: 'expense', sources: ['Dizimo'] },
  { target: 'Outros', kind: 'expense', sources: ['Outros', 'Ajuste', 'Saques', 'Assistencia'], note: 'Assistencia: confirme' },
  { target: 'Salario', kind: 'income', sources: ['Salario', 'Allowance'] },
]

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase()

export interface MergeStep {
  target: string
  kind: CategoryKind
  /** Existing category that becomes the target (renamed if needed), or null to create it. */
  keep: Category | null
  /** Categories folded into the target and then deleted. */
  absorb: Category[]
  note?: string
}

/**
 * Resolves the groups against the user's categories (names compared without accents or
 * case). The target keeps an existing category when one has its name, otherwise the first
 * source present is renamed into it, so its rules and history keep their id. Groups with
 * nothing to do are dropped.
 */
export function planMerges(categories: Category[], groups: MergeGroup[] = SIMPLIFICATION): MergeStep[] {
  const byFold = new Map(categories.map((c) => [fold(c.name), c]))
  const steps: MergeStep[] = []
  for (const g of groups) {
    const present = g.sources.map((n) => byFold.get(fold(n))).filter((c): c is Category => Boolean(c))
    const keep = byFold.get(fold(g.target)) ?? present[0] ?? null
    const absorb = present.filter((c) => c.id !== keep?.id)
    const renames = keep !== null && keep.name !== g.target
    if (!absorb.length && !renames) continue
    steps.push({ target: g.target, kind: g.kind, keep, absorb, note: g.note })
  }
  return steps
}

/** "CB IN SITU HOTEL FACT 230626" → 2026-06-23: the day of the purchase, not the day the bank booked it. */
export function purchaseDate(description: string, bookingDate: string): string {
  const m = /\bFACT (\d{2})(\d{2})(\d{2})\b/.exec(description)
  return m ? `20${m[3]}-${m[2]}-${m[1]}` : bookingDate
}
