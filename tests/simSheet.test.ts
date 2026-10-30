import { describe, expect, it } from 'vitest'
import { buildSimSheet, OTHERS, type Cell, type SimTx } from '../src/domain/simSheet'

const months = ['2026-08', '2026-09', '2026-10', '2026-11']
const avg = ['2026-07', '2026-08', '2026-09']
const tx = (month: string, amount: number, kind: SimTx['kind'], categoryName: string, merchant: string, account_id = 'a'): SimTx =>
  ({ account_id, month, amount, kind, categoryName, merchant, booking_date: `${month}-05` })
const txs: SimTx[] = [
  ...['2026-07', '2026-08', '2026-09'].flatMap((m) => [tx(m, 3000, 'income', 'Salário', 'ACME'), tx(m, -1000, 'expense', 'Moradia', 'ALUGUEL'), tx(m, -300, 'expense', 'Mercado', 'LIDL')]),
  tx('2026-10', -120, 'expense', 'Mercado', 'LIDL'), // current month: rent and salary not in yet
  tx('2026-09', -50, 'expense', 'Mercado', 'LIDL', 'b'),
]
const isRec = (m: string, kind: 'income' | 'expense', steady: Set<string>) => (kind === 'income' ? steady.has(m) : m === 'ALUGUEL')
const accounts = [{ id: 'a', name: 'Conta A', currency: 'EUR', opening: 500 }, { id: 'b', name: 'Conta B', currency: 'BRL', opening: 10 }]
const sheet = () => buildSimSheet(accounts, txs, months, '2026-10', avg, isRec, (m) => m)

/** Evaluates the sheet's formulas (only SUM ranges and + of references are used; stored without "="). */
function evaluate(rows: Cell[][]) {
  const at = (ref: string): number => {
    const [, c, r] = ref.match(/([A-Z])(\d+)/)!
    const v = rows[Number(r) - 1]?.[c.charCodeAt(0) - 65]
    const x = v && typeof v === 'object' ? v.value : v
    return typeof x === 'number' ? x : v && typeof v === 'object' && v.type === 'Formula' ? calc(`=${x}`) : 0
  }
  const calc = (f: string): number => f.slice(1).split('+').reduce((s, term) => {
    const sum = term.match(/^SUM\(([A-Z])(\d+):[A-Z](\d+)\)$/)
    if (!sum) return s + at(term)
    let t = 0
    for (let r = Number(sum[2]); r <= Number(sum[3]); r++) t += at(`${sum[1]}${r}`)
    return s + t
  }, 0)
  return (label: string, monthIdx: number, nth = 0) => {
    const row = rows.map((r, i) => [r, i] as const).filter(([r]) => r[0] === label || (r[0] as { value?: string })?.value === label || (r[1] as { value?: string })?.value === label)[nth]
    expect(row, label).toBeDefined()
    return Math.round(at(`${String.fromCharCode(67 + monthIdx)}${row[1] + 1}`) * 100) / 100
  }
}

describe('simulation sheet', () => {
  it('stacks one block per account with the same month columns', () => {
    const rows = sheet()
    expect(rows[0].length).toBe(2 + months.length)
    expect(rows.filter((r) => typeof r[0] === 'object' && r[0] && String(r[0].value).startsWith('Conta ')).map((r) => (r[0] as { value: string }).value)).toEqual(['Conta A (EUR)', 'Conta B (BRL)'])
  })

  it('fills recurring lines from the current month on, and the 3-month average in future months', () => {
    const v = evaluate(sheet())
    expect(v('ALUGUEL', 2)).toBe(-1000) // current month, not paid yet
    expect(v('ACME', 2)).toBe(3000)
    expect(v('LIDL', 2)).toBe(-120) // current month: only what came in, no average
    expect(v('ALUGUEL', 3)).toBe(-1000)
    expect(v(OTHERS, 3)).toBe(-300) // future: Mercado up to its average
  })

  it('totals and balances are formulas that roll from month to month', () => {
    const v = evaluate(sheet())
    expect(v('Saldo inicial', 0)).toBe(500)
    expect(v('Resultado do mês', 0)).toBe(1700)
    expect(v('Saldo final', 0)).toBe(2200)
    expect(v('Saldo inicial', 1)).toBe(2200)
    expect(v('Saldo final', 3)).toBe(2200 + 1700 + (3000 - 1000 - 120) + 1700)
    expect(v('Saldo final', 1, 1)).toBe(10 - 50) // second account, its own currency
  })
})
