import { grossToNet, type Country, type Household, type NetResult } from './tax'

export interface ExpenseLine { name: string; monthly: number }

export interface Scenario {
  name: string
  country: Country
  household: Household
  grossYear: number // main salary, local currency
  partnerGrossYear: number
  otherIncomeMonth: number // net, e.g. rental income, local currency
  rentMonth: number
  schoolYear: number // total tuition for all children, per year
  /** Variable spending: baseline (your actual averages, EUR) × cost-of-living index. */
  baselineVariableMonth: number
  costOfLivingIndex: number
  extraLines: ExpenseLine[]
  savingsReturnPct: number // nominal annual return on savings
  inflationPct: number
  years: number
  startingSavings: number
  fxEurBrl: number
}

export interface ScenarioResult {
  currency: 'EUR' | 'BRL'
  net: NetResult
  partnerNet: NetResult | null
  incomeMonth: number
  expenses: { rent: number; school: number; variable: number; extras: number; total: number }
  surplusMonth: number
  savingsRate: number
  surplusMonthEur: number
  projection: { year: number; savings: number; savingsReal: number }[]
}

export function runScenario(s: Scenario): ScenarioResult {
  const net = grossToNet(s.country, s.grossYear, s.household)
  const partnerNet = s.partnerGrossYear > 0 ? grossToNet(s.country, s.partnerGrossYear, { ...s.household, married: false, children: 0 }) : null
  const currency = net.currency
  const toLocal = (eur: number) => (currency === 'BRL' ? eur * s.fxEurBrl : eur)
  const incomeMonth = net.netMonth + (partnerNet?.netMonth ?? 0) + s.otherIncomeMonth
  const variable = toLocal(s.baselineVariableMonth) * s.costOfLivingIndex
  const extras = s.extraLines.reduce((a, l) => a + l.monthly, 0)
  const school = s.schoolYear / 12
  const total = s.rentMonth + school + variable + extras
  const surplusMonth = incomeMonth - total
  const r = s.savingsReturnPct / 100 / 12
  const inf = s.inflationPct / 100
  const projection: ScenarioResult['projection'] = []
  let bal = currency === 'BRL' ? s.startingSavings * s.fxEurBrl : s.startingSavings
  for (let y = 1; y <= s.years; y++) {
    for (let m = 0; m < 12; m++) bal = bal * (1 + r) + surplusMonth
    projection.push({ year: y, savings: Math.round(bal), savingsReal: Math.round(bal / Math.pow(1 + inf, y)) })
  }
  return {
    currency, net, partnerNet, incomeMonth,
    expenses: { rent: s.rentMonth, school, variable, extras, total },
    surplusMonth, savingsRate: incomeMonth > 0 ? surplusMonth / incomeMonth : 0,
    surplusMonthEur: currency === 'BRL' ? surplusMonth / s.fxEurBrl : surplusMonth,
    projection,
  }
}

export interface SavingsProposal { title: string; detail: string }

/** Concrete, sized proposals for a scenario (not financial advice — orders of magnitude). */
export function savingsProposals(s: Scenario, r: ScenarioResult, fmt: (n: number) => string): SavingsProposal[] {
  const out: SavingsProposal[] = []
  const inc = r.incomeMonth
  const emergency = r.expenses.total * 6
  if (r.surplusMonth <= 0) {
    out.push({ title: 'This scenario burns cash', detail: `Deficit of ${fmt(-r.surplusMonth)}/month. Rent + school = ${fmt(r.expenses.rent + r.expenses.school)} (${Math.round(((r.expenses.rent + r.expenses.school) / inc) * 100)}% of net income). Renegotiate package (housing/school allowance) or lower rent.` })
  }
  for (const target of [0.2, 0.3]) {
    const need = inc * target - r.surplusMonth
    out.push({ title: `Reach a ${target * 100}% savings rate`, detail: need > 0 ? `Cut ${fmt(need)}/month (≈ ${Math.round((need / Math.max(1, r.expenses.variable)) * 100)}% of variable spending).` : `Already there — ${fmt(-need)}/month above target.` })
  }
  if ((r.expenses.rent / inc) > 0.3) out.push({ title: 'Housing above 30% of net income', detail: `Each 250 of rent saved = ${fmt(250 * 12 * s.years)} over ${s.years} years before returns.` })
  out.push({ title: 'Emergency fund first', detail: `Target 6 months of expenses: ${fmt(emergency)}. Keep it in instant-access regulated savings; invest only the surplus beyond it.` })
  if (r.surplusMonth > 0) out.push({ title: 'Automate the surplus', detail: `Standing order of ${fmt(Math.floor(r.surplusMonth * 0.8 / 50) * 50)} on salary day into savings; spend what is left, not the other way round.` })
  return out
}
