/** What the average needs from an enriched transaction (value already in the budget currency). */
export interface SpendTx { month: string; value: number; kind: string; category_id: string | null }

/**
 * Average monthly spending per expense category over the given months, empty months
 * counting as zero (so a yearly bill is spread over the year). Refunds lower the
 * spending; results are rounded up to the next 10, which reads better as a budget.
 */
export function averageSpendByCategory(txs: SpendTx[], months: string[]): Map<string, number> {
  const inWindow = new Set(months)
  const sums = new Map<string, number>()
  for (const t of txs) {
    if (t.kind !== 'expense' || !t.category_id || !inWindow.has(t.month)) continue
    sums.set(t.category_id, (sums.get(t.category_id) ?? 0) - t.value)
  }
  const out = new Map<string, number>()
  for (const [id, total] of sums) {
    const avg = total / Math.max(1, months.length)
    if (avg > 0.5) out.set(id, Math.ceil(avg / 10) * 10)
  }
  return out
}

/**
 * Average monthly income of one category over the given months (empty months as zero),
 * e.g. the salary actually received, to compare with the salary typed in the budget.
 */
export function averageIncome(txs: SpendTx[], categoryId: string, months: string[]): number {
  const inWindow = new Set(months)
  const total = txs.reduce((s, t) => t.category_id === categoryId && t.kind === 'income' && inWindow.has(t.month) ? s + t.value : s, 0)
  return total / Math.max(1, months.length)
}

/**
 * The salary in force in a month. Its history is kept as budget rows of the salary category,
 * each dated with the first day of the month the value starts.
 */
export function salaryAt(rows: { month: string | null; amount: number }[], month: string): { amount: number; since: string } | null {
  const r = rows.filter((x) => x.month !== null && x.month.slice(0, 7) <= month)
    .sort((a, b) => b.month!.localeCompare(a.month!))[0]
  return r ? { amount: r.amount, since: r.month!.slice(0, 7) } : null
}

/** The income category holding the salary: "Salario", with or without accent, any case. */
export function findSalaryCategory<C extends { name: string; kind: string }>(categories: C[]): C | undefined {
  const plain = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase()
  return categories.find((c) => c.kind === 'income' && plain(c.name) === 'salario')
}
