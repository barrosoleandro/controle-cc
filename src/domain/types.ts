export type Currency = 'EUR' | 'BRL'
export type CategoryKind = 'income' | 'expense' | 'transfer'

/** A transaction as produced by a parser, before it is stored. */
export interface ParsedTransaction {
  accountRef: string // bank account number used to match accounts.external_ref
  bookingDate: string // ISO yyyy-mm-dd
  valueDate?: string
  description: string
  amount: number // signed: negative = money out
  currency: Currency
  bankCategory?: string
  bankSubcategory?: string
  externalId?: string
}

/** A bank-stated balance at a date, used to reconcile the rebuilt balance. */
export interface Checkpoint {
  accountRef: string
  date: string
  balance: number
}

export interface ParseResult {
  source: 'bcp_csv' | 'bcp_pdf' | 'itau_pdf'
  transactions: ParsedTransaction[]
  checkpoints: Checkpoint[]
  warnings: string[]
}

export interface Account {
  id: string
  name: string
  bank: string
  currency: Currency
  type: 'checking' | 'savings' | 'card'
  external_ref: string
  opening_balance: number
  opening_date: string | null
  is_active: boolean
}

export interface Category {
  id: string
  name: string
  kind: CategoryKind
  color: string
  sort: number
}

export interface Rule {
  id?: string
  pattern: string // case-insensitive substring match on description
  bank?: string | null
  sign?: 'debit' | 'credit' | null
  category: string // category name (resolved to id on save)
  priority: number
  active?: boolean
}

export interface BankMapEntry {
  bank: string
  bank_category: string
  bank_subcategory: string // '*' = any
  category: string
}

export interface Transaction {
  id: string
  account_id: string
  booking_date: string
  value_date: string | null
  description: string
  merchant: string
  amount: number
  currency: Currency
  bank_category: string | null
  bank_subcategory: string | null
  category_id: string | null
  category_locked: boolean
  notes: string | null
  source: string
  fingerprint: string
}
