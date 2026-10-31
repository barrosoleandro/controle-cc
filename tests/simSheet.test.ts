import { describe, expect, it } from 'vitest'
import { BILL, buildSimSheet, OTHERS, projectCardBill, RECEIVED, SENT, type Cell, type SimTx } from '../src/domain/simSheet'

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

const colOf = (n: number): string => (n > 26 ? colOf(Math.floor((n - 1) / 26)) : '') + String.fromCharCode(65 + ((n - 1) % 26))

/** Evaluates the sheet's formulas (stored without "="): SUM ranges, MAX, CEILING, + − / of references. */
function evaluate(rows: Cell[][]) {
  const at = (ref: string): number => {
    const [, c, r] = ref.replace(/\$/g, '').match(/([A-Z]+)(\d+)/)!
    const v = rows[Number(r) - 1]?.[[...c].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1]
    const x = v && typeof v === 'object' ? v.value : v
    return typeof x === 'number' ? x : v && typeof v === 'object' && v.type === 'Formula' ? calc(String(x)) : 0
  }
  const calc = (f: string): number => {
    const js = f
      .replace(/SUM\(([A-Z]+)(\d+):[A-Z]+(\d+)\)/g, (_, c, a, b) => `(${Array.from({ length: b - a + 1 }, (_, k) => at(`${c}${Number(a) + k}`)).join('+')})`)
      .replace(/\$?[A-Z]+\$?\d+/g, (ref) => `(${at(ref)})`)
      .replace(/MAX\(/g, 'Math.max(').replace(/CEILING\(/g, 'ceil(')
    return new Function('ceil', `return ${js}`)((x: number, s: number) => Math.ceil(x / s) * s)
  }
  return (label: string, monthIdx: number, nth = 0) => {
    const row = rows.map((r, i) => [r, i] as const).filter(([r]) => r[0] === label || (r[0] as { value?: string })?.value === label || (r[1] as { value?: string })?.value === label)[nth]
    expect(row, label).toBeDefined()
    return Math.round(at(`${colOf(monthIdx + 3)}${row[1] + 1}`) * 100) / 100
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

  it('Brazil: card only as its bill, transfer estimated by the Painel rule while nothing arrived', () => {
    const br: SimTx[] = [
      ...['2026-07', '2026-08', '2026-09'].flatMap((m) => [
        tx(m, -2000, 'expense', 'Cartão Itaú', 'PAGAMENTO FATURA', 'i'), tx(m, -500, 'expense', 'Saúde', 'UNIMED', 'i'), tx(m, -100, 'expense', 'Lazer', 'BAR', 'i'),
        { ...tx(m, 2600, 'transfer', 'Transferência', 'WISE', 'i'), description: 'WISE PAYMENTS' },
      ]),
      { ...tx('2026-10', 900, 'transfer', 'Transferência', 'WISE', 'i'), description: 'WISE PAYMENTS' }, // October already sent
    ]
    const accs = [{ id: 'a', name: 'BCP', currency: 'EUR', opening: 500 }, { id: 'i', name: 'Itaú', currency: 'BRL', opening: 100 }]
    const rec = (m: string, kind: 'income' | 'expense', steady: Set<string>) => (kind === 'income' ? steady.has(m) : m === 'UNIMED' || m === 'ALUGUEL')
    const rows = buildSimSheet(accs, [...txs.filter((t) => t.account_id === 'a'), ...br], months, '2026-10', avg, rec, (m) => m,
      { from: 'a', to: 'i', rate: 6, bill: (m) => (m === '2026-11' ? 1800 : 0) })
    const v = evaluate(rows)
    expect(v(BILL, 1)).toBe(-2000) // the payment shows as the bill total
    expect(v(BILL, 3)).toBe(-1800) // projected bill
    expect(v(RECEIVED, 2)).toBe(0) // already sent in October: no estimate
    // November: bill 1800 + UNIMED 500 − opening of the month, rounded up to 10
    const open = v('Saldo inicial', 3, 1)
    expect(v(RECEIVED, 3)).toBe(Math.max(0, Math.ceil((1800 + 500 - open) / 10) * 10))
    expect(v(SENT, 3)).toBeCloseTo(-v(RECEIVED, 3) / 6, 2)
    // The Itaú balance never goes below what the recurring lines need (only the rest of the spending is uncovered).
    expect(v('Saldo final', 3, 1)).toBeCloseTo(open + v(RECEIVED, 3) - 1800 - 500 - 100, 2)
  })

  it('projects the card bill from open bills, then assigned purchases, then the current month', () => {
    expect(projectCardBill('2026-11', '2026-10', [{ due_date: '2026-11-10', total: 700 }], [])).toBe(700)
    expect(projectCardBill('2026-12', '2026-10', [], [{ month: '2026-10', amount: -50, statement_due: '2026-12-10' }])).toBe(50)
    expect(projectCardBill('2026-11', '2026-10', [], [{ month: '2026-10', amount: -80 }])).toBe(80)
    expect(projectCardBill('2026-12', '2026-10', [], [{ month: '2026-10', amount: -80 }])).toBe(0)
  })

  it('any number of months (past Z), and no row without a value in the period', () => {
    const long = Array.from({ length: 27 }, (_, i) => new Date(Date.UTC(2024, 10 + i, 1)).toISOString().slice(0, 7)) // 2024-11 … 2027-01
    const data = [...txs, tx('2025-01', -40, 'expense', 'Lazer', 'CINEMA'), tx('2026-08', 25, 'expense', 'Lazer', 'ESTORNO'), tx('2026-08', -25, 'expense', 'Lazer', 'ESTORNO')]
    const rows = buildSimSheet([...accounts, { id: 'z', name: 'Conta vazia', currency: 'EUR', opening: 0 }], data, long, '2026-10', avg, isRec, (m) => m)
    expect(rows[0].length).toBe(2 + 27)
    const v = evaluate(rows)
    expect(v('CINEMA', 2)).toBe(-40) // 2025-01, column E
    expect(v('Saldo final', 26)).toBe(v('Saldo inicial', 26) + v('Resultado do mês', 26)) // column AC
    const labels = rows.map((r) => r.map((c) => (c && typeof c === 'object' ? c.value : c)))
    expect(labels.some((r) => r[1] === 'ESTORNO')).toBe(false) // nets to zero in every month
    expect(labels.some((r) => String(r[0]).startsWith('Conta vazia'))).toBe(false)
    // With a short window, merchants only seen before it are left out.
    const short = buildSimSheet(accounts, data, months, '2026-10', avg, isRec, (m) => m).map((r) => r.map((c) => (c && typeof c === 'object' ? c.value : c)))
    expect(short.some((r) => r[1] === 'CINEMA')).toBe(false)
  })

  it('salary paid at the end of the month before shows in the month it is for, counted once', () => {
    // Paid on the 30th for the next month, from June on; the one of 30/out (November's) is already in.
    const pay = (m: string) => ({ ...tx(m, 3000, 'income', 'Salário', 'ACME'), booking_date: `${m}-30` })
    const data = [...['2026-06', '2026-07', '2026-08', '2026-09', '2026-10'].map(pay), ...['2026-08', '2026-09', '2026-10'].map((m) => tx(m, -1000, 'expense', 'Moradia', 'ALUGUEL'))]
    const rows = buildSimSheet([{ id: 'a', name: 'Conta A', currency: 'EUR', opening: 3500 }], data, months, '2026-10', avg, isRec, (m) => m, undefined, 'Salário')
    const v = evaluate(rows)
    // 2026-08 … 2026-11: one salary each, November's being the one credited on 30/out; none extra after.
    expect([0, 1, 2, 3].map((i) => v('ACME', i))).toEqual([3000, 3000, 3000, 3000])
    // The opening (bank: 3500) leaves out August's salary, credited on 30/jul and shown in August.
    expect(v('Saldo inicial', 0)).toBe(500)
    expect(v('Saldo final', 3)).toBe(500 + 4 * 3000 - 1000 * 4)
    // Without the salary category, the same data is plain cash: the 30/out credit stays in October.
    expect(evaluate(buildSimSheet([{ id: 'a', name: 'Conta A', currency: 'EUR', opening: 3500 }], data, months, '2026-10', avg, isRec, (m) => m))('ACME', 2)).toBe(3000)
  })

  it('checks each month against the bank statement balance, salary paid early added back', () => {
    const pay = (m: string) => ({ ...tx(m, 3000, 'income', 'Salário', 'ACME'), booking_date: `${m}-30` })
    const data = [...['2026-07', '2026-08', '2026-09'].map(pay), tx('2026-08', -1000, 'expense', 'Moradia', 'ALUGUEL'), tx('2026-09', -1000, 'expense', 'Moradia', 'ALUGUEL')]
    // Bank: 3500 on 31/jul (with August's salary), 5500 on 31/ago, but 6000 on 30/set: 1500 short in the app.
    const bank = { '2026-07-31': 3500, '2026-08-31': 5500, '2026-09-30': 6000 }
    const v = evaluate(buildSimSheet([{ id: 'a', name: 'Conta A', currency: 'EUR', opening: 3500, bank }], data, months, '2026-10', avg, isRec, (m) => m, undefined, 'Salário'))
    expect(v('Saldo no extrato do banco', 0)).toBe(5500)
    expect(v('Diferença (planilha − banco)', 0)).toBe(0)
    expect(v('Diferença (planilha − banco)', 1)).toBe(1500)
  })

  it('closing as the bank has it: the next salary already credited, or expected in projected months', () => {
    const pay = (m: string) => ({ ...tx(m, 3000, 'income', 'Salário', 'ACME'), booking_date: `${m}-30` })
    const data = [...['2026-07', '2026-08', '2026-09'].map(pay), ...['2026-08', '2026-09'].map((m) => tx(m, -1000, 'expense', 'Moradia', 'ALUGUEL'))]
    const v = evaluate(buildSimSheet([{ id: 'a', name: 'Conta A', currency: 'EUR', opening: 3500 }], data, months, '2026-10', avg, isRec, (m) => m, undefined, 'Salário'))
    // August and September: September's / October's salary credited on the 30th.
    expect(v('Saldo final (como no banco)', 0)).toBe(v('Saldo final', 0) + 3000)
    expect(v('Saldo final (como no banco)', 1)).toBe(v('Saldo final', 1) + 3000)
    // October (current, November's salary not in yet): November's salary as projected; last month: nothing to add.
    expect(v('Saldo final (como no banco)', 2)).toBe(v('Saldo final', 2) + v('Salário', 3))
    expect(v('Saldo final (como no banco)', 3)).toBe(v('Saldo final', 3))
  })

  it('Brazil: money from abroad that became income (no other side) still counts as the month sent', () => {
    const br: SimTx[] = [
      ...['2026-07', '2026-08', '2026-09'].map((m) => tx(m, -500, 'expense', 'Saúde', 'UNIMED', 'i')),
      { ...tx('2026-10', 900, 'income', 'Transferência externa', 'WISE', 'i'), description: 'WISE PAYMENTS' },
    ]
    const accs = [{ id: 'a', name: 'BCP', currency: 'EUR', opening: 500 }, { id: 'i', name: 'Itaú', currency: 'BRL', opening: 100 }]
    const rec = (m: string, kind: 'income' | 'expense') => kind === 'expense' && m === 'UNIMED'
    const v = evaluate(buildSimSheet(accs, br, months, '2026-10', avg, rec, (m) => m, { from: 'a', to: 'i', rate: 6, bill: () => 0 }))
    expect(v(RECEIVED, 2)).toBe(0) // October: already sent
    expect(v(RECEIVED, 3)).toBeGreaterThan(0) // November: estimated
  })
})
