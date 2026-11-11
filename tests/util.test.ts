import { describe, expect, it } from 'vitest'
import { lastDayOfMonth, prevMonth, round2, unaccent } from '../src/domain/util'

describe('shared helpers', () => {
  it('rounds to cents and strips accents', () => {
    expect(round2(10.006)).toBe(10.01)
    expect(unaccent('Salário à vista — Nº 1')).toBe('Salario a vista — Nº 1')
  })
  it('knows the month before and the last day of a month', () => {
    expect(prevMonth('2026-01')).toBe('2025-12')
    expect(prevMonth('2026-11')).toBe('2026-10')
    expect(['2026-02', '2024-02', '2026-11', '2026-12'].map(lastDayOfMonth)).toEqual(['2026-02-28', '2024-02-29', '2026-11-30', '2026-12-31'])
  })
})
