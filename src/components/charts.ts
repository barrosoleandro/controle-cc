/** Chart colors come from CSS tokens so light/dark are both validated steps (dataviz reference palette). */
export const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)']
export const axis = { stroke: 'var(--muted)', fontSize: 12, tickLine: false, axisLine: false } as const
export const grid = { stroke: 'var(--grid)', vertical: false } as const
export const tooltipStyle = { contentStyle: { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, color: 'var(--text)' } }
export const compact = (n: number) => new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
