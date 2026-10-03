import type { Basis, BenchmarkRole, Currency } from './market'

/**
 * Reading a benchmark base from a file. The layout is deliberately plain so a table
 * copied out of APEC, Syntec, Glassdoor or a spreadsheet can be saved as CSV and read
 * here, in the browser, like every other import in this app.
 *
 * Header, in any order, accents and case ignored:
 *   cargo, regiao, data, fonte, url, base, moeda, p25, p50, p75, amostra, oficial, observacao
 * Only cargo, data, fonte and p50 are required.
 */

export const CSV_HEADER = 'cargo;regiao;data;fonte;url;base;moeda;p25;p50;p75;amostra;oficial;observacao'

export const CSV_EXAMPLE = [
  CSV_HEADER,
  'CIO regional;Europa;2026-06-30;APEC;https://www.apec.fr;bruto_anual;EUR;150000;185000;230000;120;nao;estudo cadres SI',
  'Head de Dados;Europa;2026-06-30;Glassdoor;;bruto_anual;EUR;95000;118000;140000;;nao;',
].join('\n')

const BASIS_WORDS: Record<string, Basis> = {
  bruto_anual: 'gross_year', brutoanual: 'gross_year', gross_year: 'gross_year', anual: 'gross_year',
  bruto_mensal: 'gross_month', brutomensal: 'gross_month', gross_month: 'gross_month', mensal: 'gross_month',
  liquido_mensal: 'net_month', liquidomensal: 'net_month', net_month: 'net_month',
  remuneracao_total: 'total_comp_year', total: 'total_comp_year', total_comp_year: 'total_comp_year',
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase()

/** '185 000,50', '185.000,50', '185000.50' and '€185,000' all mean the same number. */
export function parseAmount(raw: string): number | null {
  const s = raw.replace(/[^\d,.-]/g, '').trim()
  if (!s) return null
  // Whichever separator comes last is the decimal one; the other groups thousands. But one
  // lone separator followed by exactly three digits groups thousands rather than marking a
  // decimal: '185,000' is 185000 in an English table, and nobody writes 185.0 that way.
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.')
  const lone = /^-?\d{1,3}[,.]\d{3}$/.test(s)
  let normalized = s
  if (lone) normalized = s.replace(/[,.]/g, '')
  else if (lastComma > lastDot) normalized = s.replace(/\./g, '').replace(',', '.')
  else if (lastDot > lastComma) normalized = s.replace(/,/g, '')
  else normalized = s.replace(/[,.]/g, '')
  const n = Number(normalized)
  return Number.isFinite(n) ? n : null
}

/** Accepts 2026-06-30, 30/06/2026 and 06/2026 (taken as the last day of that month). */
export function parseAsOf(raw: string): string | null {
  const s = raw.trim()
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (m) return s
  m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s)
  if (m) return `${m[3]}-${m[2]}-${m[1]}`
  m = /^(\d{4})-(\d{2})$/.exec(s) || /^(\d{2})\/(\d{4})$/.exec(s)
  if (m) {
    const [y, mo] = /^\d{4}/.test(m[1]) ? [m[1], m[2]] : [m[2], m[1]]
    const last = new Date(Date.UTC(Number(y), Number(mo), 0)).getUTCDate()
    return `${y}-${mo}-${String(last).padStart(2, '0')}`
  }
  return null
}

export interface ImportedEntry {
  roleName: string
  region: string
  as_of: string
  source: string
  source_url: string
  basis: Basis
  currency: Currency
  p25: number | null
  p50: number | null
  p75: number | null
  sample_size: number | null
  official: boolean
  notes: string
}

export interface ImportResult {
  entries: ImportedEntry[]
  /** Roles named in the file that do not exist yet — the screen offers to create them. */
  newRoles: { name: string; region: string }[]
  errors: string[]
}

const get = (row: Record<string, string>, ...names: string[]): string => {
  for (const n of names) {
    const hit = Object.keys(row).find((k) => fold(k) === n)
    if (hit && row[hit] != null) return String(row[hit])
  }
  return ''
}

/**
 * Turns parsed CSV rows into entries. A row that cannot be read is reported with its
 * line number rather than silently dropped — a benchmark quietly missing a quartile
 * would skew the comparison without anyone noticing.
 */
export function parseBenchmarkRows(rows: Record<string, string>[], roles: BenchmarkRole[]): ImportResult {
  const entries: ImportedEntry[] = []
  const errors: string[] = []
  const newRoles = new Map<string, { name: string; region: string }>()
  const known = new Set(roles.map((r) => fold(r.name)))

  rows.forEach((row, i) => {
    const line = i + 2 // header is line 1
    const roleName = get(row, 'cargo', 'role', 'funcao').trim()
    const source = get(row, 'fonte', 'source').trim()
    const asOfRaw = get(row, 'data', 'as_of', 'date').trim()
    const p50 = parseAmount(get(row, 'p50', 'mediana', 'median'))
    if (!roleName && !source && !asOfRaw && p50 === null) return // blank line

    const problems: string[] = []
    if (!roleName) problems.push('falta o cargo')
    if (!source) problems.push('falta a fonte')
    const as_of = parseAsOf(asOfRaw)
    if (!as_of) problems.push(`data inválida ("${asOfRaw}")`)
    if (p50 === null) problems.push('falta a mediana (p50)')
    if (problems.length) { errors.push(`linha ${line}: ${problems.join('; ')}`); return }

    const basisWord = fold(get(row, 'base', 'basis')) || 'bruto_anual'
    const basis = BASIS_WORDS[basisWord.replace(/\s+/g, '_')]
    if (!basis) { errors.push(`linha ${line}: base "${basisWord}" não reconhecida (use bruto_anual, bruto_mensal, liquido_mensal ou remuneracao_total)`); return }

    const cur = fold(get(row, 'moeda', 'currency')) || 'eur'
    if (cur !== 'eur' && cur !== 'brl') { errors.push(`linha ${line}: moeda "${cur}" não suportada (EUR ou BRL)`); return }

    const region = get(row, 'regiao', 'region').trim()
    if (!known.has(fold(roleName))) newRoles.set(fold(roleName), { name: roleName, region })

    const amostra = parseAmount(get(row, 'amostra', 'sample', 'sample_size'))
    entries.push({
      roleName, region, as_of: as_of!, source,
      source_url: get(row, 'url', 'source_url', 'link').trim(),
      basis, currency: cur.toUpperCase() as Currency,
      p25: parseAmount(get(row, 'p25', 'minimo', 'min')),
      p50,
      p75: parseAmount(get(row, 'p75', 'maximo', 'max')),
      sample_size: amostra === null ? null : Math.round(amostra),
      official: ['sim', 's', 'true', '1', 'yes'].includes(fold(get(row, 'oficial', 'official'))),
      notes: get(row, 'observacao', 'notes', 'obs').trim(),
    })
  })

  return { entries, newRoles: [...newRoles.values()], errors }
}
