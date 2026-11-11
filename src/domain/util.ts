/** Small helpers shared by the domain, the parsers and the pages. No dependencies. */

/** To cents: 121.575 → 121.58 (up to binary floats; rescisão keeps its own, stricter one). */
export const round2 = (n: number) => Math.round(n * 100) / 100

/** Without accents: "Salário" → "Salario". Case and spacing are the caller's business. */
export const unaccent = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '')

/** The month before `month` (yyyy-mm). */
export function prevMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

/** Last day of `month` (yyyy-mm) as yyyy-mm-dd. */
export function lastDayOfMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`
}
