/**
 * Gross-yearly → net-monthly salary estimators for employees.
 * These are SIMPLIFIED models for scenario comparison, not payroll-grade calculations:
 * they ignore local surcharges, specific deductions/credits beyond the ones listed and
 * employer-specific benefits. All parameters live in TAX_PARAMS so they can be updated yearly.
 * Sources (checked Sep 2026): service-public.gouv.fr F1419 (FR scale on 2025 income),
 * PwC Portugal OE2026, taxx.lu + PwC tax summaries (LU), Lei 15.270/2025 tables (BR).
 */
export type Country = 'FR' | 'PT' | 'LU' | 'BR' | 'CUSTOM'

export interface Household {
  married: boolean
  children: number
  /** Portugal IFICI ("NHR 2.0") 20% flat rate on qualifying employment income. */
  ptIfici?: boolean
  /** Custom country: all-in effective rate (social + income tax) on gross. */
  customEffectiveRate?: number
}

export interface NetResult {
  country: Country
  currency: 'EUR' | 'BRL'
  grossYear: number
  social: number
  incomeTax: number
  netYear: number
  netMonth: number
  effectiveRate: number
  notes: string[]
}

type Bracket = [upTo: number, rate: number]
const progressive = (income: number, brackets: Bracket[]) => {
  let tax = 0
  let lower = 0
  for (const [upTo, rate] of brackets) {
    if (income <= lower) break
    tax += (Math.min(income, upTo) - lower) * rate
    lower = upTo
  }
  return tax
}

export const TAX_PARAMS = {
  FR: {
    employeeSocialRate: 0.22, // cadre, private sector, approx. gross→net before tax
    nonDeductibleCsg: 0.029, // CSG/CRDS non-deductible, added back to taxable income
    proExpensesRate: 0.1,
    proExpensesCap: 14426,
    brackets: [[11600, 0], [29579, 0.11], [84577, 0.3], [181917, 0.41], [Infinity, 0.45]] as Bracket[],
    halfPartCap: 1807,
  },
  PT: {
    employeeSocialRate: 0.11,
    specificDeduction: 4587, // dedução específica (approx. 8.54 × IAS)
    dependentCredit: 600,
    brackets: [[8342, 0.125], [12587, 0.157], [17838, 0.212], [23089, 0.241], [29397, 0.311], [43090, 0.349], [46566, 0.431], [86634, 0.446], [Infinity, 0.48]] as Bracket[],
    solidarity: [[80000, 0], [250000, 0.025], [Infinity, 0.05]] as Bracket[],
    ificiRate: 0.2,
  },
  LU: {
    pension: 0.085,
    health: 0.028,
    socialCeilingMonth: 13856.63,
    dependency: 0.014,
    dependencyAllowanceMonth: 692.83,
    lumpDeductions: 540 + 396, // frais d'obtention + dépenses spéciales forfaitaires (approx.)
    brackets: [[13230, 0], [15435, 0.08], [17640, 0.09], [19845, 0.1], [22050, 0.11], [24255, 0.12], [26550, 0.14], [28845, 0.16], [31140, 0.18], [33435, 0.2], [35730, 0.22], [38025, 0.24], [40320, 0.26], [42615, 0.28], [44910, 0.3], [47205, 0.32], [49500, 0.34], [51795, 0.36], [54090, 0.38], [117450, 0.39], [176160, 0.4], [234870, 0.41], [Infinity, 0.42]] as Bracket[],
    employmentFund: 0.07,
    employmentFundHigh: 0.09,
    childBonusYear: 922, // crédit d'impôt/boni pour enfant (approx.)
  },
  BR: {
    salariesPerYear: 13 + 1 / 3, // 12 + 13º + 1/3 férias
    inss: [[1621, 0.075], [2902.84, 0.09], [4354.27, 0.12], [8475.55, 0.14]] as Bracket[],
    irrf: [[2428.8, 0], [2826.65, 0.075], [3751.05, 0.15], [4664.68, 0.225], [Infinity, 0.275]] as Bracket[],
    dependentMonth: 189.59,
    reductionFull: 5000,
    reductionEnd: 7350,
  },
}

export function grossToNet(country: Country, grossYear: number, h: Household): NetResult {
  const notes: string[] = []
  let social = 0
  let incomeTax = 0
  let currency: 'EUR' | 'BRL' = 'EUR'

  if (country === 'FR') {
    const p = TAX_PARAMS.FR
    social = grossYear * p.employeeSocialRate
    const netSocial = grossYear - social
    const taxable = netSocial + grossYear * p.nonDeductibleCsg
    const net = taxable - Math.min(taxable * p.proExpensesRate, p.proExpensesCap)
    const baseParts = h.married ? 2 : 1
    const childParts = h.children <= 2 ? h.children * 0.5 : 1 + (h.children - 2)
    const parts = baseParts + childParts
    const taxWith = progressive(net / parts, p.brackets) * parts
    const taxBase = progressive(net / baseParts, p.brackets) * baseParts
    const cap = (childParts * 2) * p.halfPartCap
    incomeTax = Math.max(taxWith, taxBase - cap)
    notes.push(`${parts} parts fiscales; quotient familial capped at ${p.halfPartCap} €/half-part`)
  } else if (country === 'PT') {
    const p = TAX_PARAMS.PT
    social = grossYear * p.employeeSocialRate
    if (h.ptIfici) {
      incomeTax = grossYear * p.ificiRate
      notes.push('IFICI: 20% flat on qualifying employment income (eligibility must be confirmed).')
    } else {
      const taxable = Math.max(0, grossYear - Math.max(p.specificDeduction, social))
      const split = h.married ? 2 : 1
      incomeTax = progressive(taxable / split, p.brackets) * split
      incomeTax += progressive(taxable, p.solidarity)
      incomeTax = Math.max(0, incomeTax - h.children * p.dependentCredit)
      notes.push('Joint taxation (quociente conjugal) when married; one earner assumed.')
    }
  } else if (country === 'LU') {
    const p = TAX_PARAMS.LU
    const capped = Math.min(grossYear, p.socialCeilingMonth * 12)
    social = capped * (p.pension + p.health) + Math.max(0, grossYear - p.dependencyAllowanceMonth * 12) * p.dependency
    const taxable = Math.max(0, grossYear - capped * (p.pension + p.health) - p.lumpDeductions)
    const cls2 = h.married
    const base = cls2 ? progressive(taxable / 2, p.brackets) * 2 : progressive(taxable, p.brackets)
    const fundRate = taxable > (cls2 ? 300000 : 150000) ? p.employmentFundHigh : p.employmentFund
    incomeTax = Math.max(0, base * (1 + fundRate) - h.children * p.childBonusYear)
    notes.push(cls2 ? 'Tax class 2 (splitting).' : 'Tax class 1.', 'Includes 7%/9% employment-fund surcharge.')
  } else if (country === 'BR') {
    const p = TAX_PARAMS.BR
    currency = 'BRL'
    const monthly = grossYear / p.salariesPerYear
    const inss = progressive(monthly, p.inss)
    const base = monthly - inss - h.children * p.dependentMonth
    let irrf = progressive(base, p.irrf)
    if (monthly <= p.reductionFull) irrf = 0
    else if (monthly <= p.reductionEnd) irrf = Math.max(0, irrf - (978.62 - 0.133145 * monthly))
    social = inss * p.salariesPerYear
    incomeTax = irrf * p.salariesPerYear
    notes.push('CLT employee; gross/yr includes 13º and 1/3 férias. PJ contracts are taxed differently.')
  } else {
    const r = h.customEffectiveRate ?? 0.35
    incomeTax = grossYear * r
    notes.push(`Custom all-in effective rate ${(r * 100).toFixed(0)}%.`)
  }

  const netYear = grossYear - social - incomeTax
  return {
    country, currency, grossYear,
    social: round(social), incomeTax: round(incomeTax), netYear: round(netYear),
    netMonth: round(netYear / 12),
    effectiveRate: grossYear > 0 ? (social + incomeTax) / grossYear : 0,
    notes,
  }
}

const round = (n: number) => Math.round(n * 100) / 100
