/** Least-squares line through the points (x = 0, 1, 2…); null values are skipped. */
export function linearTrend(values: (number | null)[]): { slope: number; intercept: number } | null {
  const pts = values.map((y, x) => [x, y] as const).filter((p): p is readonly [number, number] => p[1] !== null)
  if (pts.length < 2) return null
  const n = pts.length
  const mx = pts.reduce((s, [x]) => s + x, 0) / n
  const my = pts.reduce((s, [, y]) => s + y, 0) / n
  const sxx = pts.reduce((s, [x]) => s + (x - mx) ** 2, 0)
  const slope = sxx ? pts.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0) / sxx : 0
  return { slope, intercept: my - slope * mx }
}

/** Running totals, e.g. spending accumulated month by month through a year. */
export function cumulative(values: number[]): number[] {
  return values.reduce<number[]>((out, v) => [...out, (out.at(-1) ?? 0) + v], [])
}
