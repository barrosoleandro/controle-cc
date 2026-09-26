/** '25/09/2026' -> '2026-09-25' */
export function frDateToIso(d: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d.trim())
  if (!m) throw new Error(`Invalid date: ${d}`)
  return `${m[3]}-${m[2]}-${m[1]}`
}

/** Parses '-1 234,56', '+ 1 234,56', '1.234,56', '-25.996,24' into a number. */
export function parseEuroNumber(s: string): number {
  const cleaned = s.replace(/\s| | /g, '').replace(/\./g, '').replace(',', '.')
  const n = Number(cleaned)
  if (!Number.isFinite(n)) throw new Error(`Invalid amount: ${s}`)
  return Math.round(n * 100) / 100
}

export const round2 = (n: number) => Math.round(n * 100) / 100
