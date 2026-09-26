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
