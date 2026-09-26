/** Where each bank's accounts live, for the by-country analysis. */
export type Country = 'Brasil' | 'França' | 'Portugal' | 'Outro'
export const COUNTRIES: Country[] = ['Brasil', 'França', 'Portugal', 'Outro']

const BY_BANK: Record<string, Country> = { ITAU: 'Brasil', BCP: 'França', CCF: 'França', MILLENNIUM: 'Portugal' }

export function countryOf(bank: string): Country {
  return BY_BANK[bank.toUpperCase()] ?? 'Outro'
}

/** What the analysis needs from an enriched transaction (value in display currency). */
export interface FlowTx { month: string; value: number; kind: string; account_id: string }
export interface Flow { income: number; expense: number }

/**
 * Money received and spent per month and country. Transfers (between the user's own
 * accounts, card bill payments) are left out; a refund inside an expense category lowers
 * the spending. Expenses are positive.
 */
export function flowsByCountry(txs: FlowTx[], countryOfAccount: Map<string, Country>, months: string[]) {
  const inWindow = new Set(months)
  const cells = new Map<string, Flow>()
  const totals = new Map<Country, Flow>()
  const add = (map: Map<string, Flow>, key: string, t: FlowTx) => {
    const f = map.get(key) ?? { income: 0, expense: 0 }
    if (t.kind === 'income') f.income += t.value
    else f.expense -= t.value
    map.set(key, f)
  }
  for (const t of txs) {
    if (t.kind === 'transfer' || !inWindow.has(t.month)) continue
    const c = countryOfAccount.get(t.account_id)
    if (!c) continue
    add(cells, `${t.month}|${c}`, t)
    add(totals as Map<string, Flow>, c, t)
  }
  const countries = COUNTRIES.filter((c) => totals.has(c))
  const cell = (month: string, c: Country): Flow => cells.get(`${month}|${c}`) ?? { income: 0, expense: 0 }
  return { countries, totals: (c: Country) => totals.get(c) ?? { income: 0, expense: 0 }, cell }
}
