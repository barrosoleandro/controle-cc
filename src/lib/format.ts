import type { Currency } from '../domain/types'
export const money = (cur: Currency, digits = 0) => {
  const f = new Intl.NumberFormat(cur === 'BRL' ? 'pt-BR' : 'fr-FR', { style: 'currency', currency: cur, maximumFractionDigits: digits, minimumFractionDigits: digits })
  return (n: number) => f.format(n)
}
export const monthLabel = (m: string) => {
  const [y, mo] = m.split('-').map(Number)
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString('pt-BR', { month: 'short', year: '2-digit', timeZone: 'UTC' })
}
