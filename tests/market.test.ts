import { describe, expect, it } from 'vitest'
import { cell, cells, categories } from '../src/domain/jsonstat'
import { earningsUrl, parseEarnings } from '../src/domain/earnings'
import { compareRole, myGrossYear, position, toGrossYear, type BenchmarkEntry, type BenchmarkRole } from '../src/domain/market'
import { parseAmount, parseAsOf, parseBenchmarkRows } from '../src/domain/marketImport'

/**
 * The real answer for earn_ses22_25, managers (OC1), 2022, EUR/month, for FR/PT/ES/BE/NL/LU
 * and the EU average. Several cells are withheld — Luxembourg publishes nothing and Belgium
 * only one size class — which is exactly what the parser has to survive.
 */
const SES = {
  label: 'Mean monthly earnings by sex, occupation and size class of the enterprise (2022)',
  updated: '2026-02-09T23:00:00+0100',
  id: ['freq', 'sex', 'indic_se', 'isco08', 'sizeclas', 'unit', 'geo', 'time'],
  size: [1, 1, 1, 1, 6, 1, 7, 1],
  dimension: {
    freq: { category: { index: { A: 0 } } },
    sex: { category: { index: { T: 0 } } },
    indic_se: { category: { index: { ERN: 0 } } },
    isco08: { category: { index: { OC1: 0 }, label: { OC1: 'Managers' } } },
    sizeclas: { category: { index: { '1-9': 0, '10-49': 1, '50-249': 2, '250-499': 3, '500-999': 4, GE1000: 5 } } },
    unit: { category: { index: { EUR: 0 } } },
    geo: { category: { index: { EU27_2020: 0, BE: 1, ES: 2, FR: 3, LU: 4, NL: 5, PT: 6 } } },
    time: { category: { index: { 2022: 0 } } },
  },
  // flat = sizeclas*7 + geo
  value: {
    2: 4767, 5: 5902, // 1-9: ES, NL
    7: 4675, 9: 4139, 10: 5231, 12: 6039, 13: 2840, // 10-49: EU, ES, FR, NL, PT
    14: 5354, 15: 8120, 16: 4671, 17: 5651, 19: 6683, 20: 3838, // 50-249: EU, BE, ES, FR, NL, PT
    21: 5833, 23: 4436, 24: 6384, // 250-499
    28: 5996, 30: 4624, 31: 6272, 33: 6883, // 500-999
    35: 5735, 37: 4266, 38: 5685, // GE1000: EU, ES, FR
  } as Record<string, number>,
}

describe('reading JSON-stat', () => {
  it('lists a dimension in declared order', () => {
    expect(categories(SES, 'geo')).toEqual(['EU27_2020', 'BE', 'ES', 'FR', 'LU', 'NL', 'PT'])
  })

  it('resolves coordinates rather than reading by position', () => {
    const fr = cell(SES, { geo: 'FR', sizeclas: 'GE1000' })
    expect(fr?.value).toBe(5685)
    expect(cell(SES, { geo: 'PT', sizeclas: '50-249' })?.value).toBe(3838)
  })

  it('treats a withheld cell as absent, never as zero', () => {
    expect(cell(SES, { geo: 'LU', sizeclas: 'GE1000' })).toBeNull()
    expect(cells(SES).some((c) => c.coords.geo === 'LU')).toBe(false)
    expect(cells(SES).every((c) => c.value > 0)).toBe(true)
  })

  it('refuses an ambiguous selection instead of picking one', () => {
    expect(() => cell(SES, { geo: 'FR' })).toThrow(/mais de um/i)
  })
})

describe('official earnings across Europe', () => {
  it('asks Eurostat for the documented series', () => {
    const u = earningsUrl(['FR', 'PT'], 'OC1')
    expect(u).toContain('earn_ses22_25')
    expect(u).toContain('indic_se=ERN')
    expect(u).toContain('isco08=OC1')
    expect(u).toContain('unit=EUR')
    expect(u).toContain('geo=FR')
    expect(u).toContain('geo=PT')
  })

  it('groups by country, largest employer size first', () => {
    const r = parseEarnings(SES, ['FR', 'PT', 'ES', 'BE', 'NL', 'LU', 'EU27_2020'])
    const fr = r.byGeo.find((g) => g.geo === 'FR')!
    expect(fr.label).toBe('França')
    expect(fr.headline?.sizeClass).toBe('GE1000')
    expect(fr.headline?.monthly).toBe(5685)
    expect(fr.rows[0].monthly).toBe(5685)
  })

  it('falls back to the largest class a country actually publishes', () => {
    const r = parseEarnings(SES)
    // The Netherlands has no 1000+ cell: the headline is the 500–999 one.
    expect(r.byGeo.find((g) => g.geo === 'NL')!.headline).toMatchObject({ sizeClass: '500-999', monthly: 6883 })
    // Belgium publishes a single class.
    expect(r.byGeo.find((g) => g.geo === 'BE')!.rows).toHaveLength(1)
  })

  it('names the countries that publish nothing instead of showing a zero', () => {
    const r = parseEarnings(SES, ['FR', 'LU', 'PT'])
    expect(r.withheld).toEqual(['LU'])
    expect(r.byGeo.some((g) => g.geo === 'LU')).toBe(false)
  })

  it('carries the occupation label and the reference year', () => {
    const r = parseEarnings(SES)
    expect(r.iscoLabel).toBe('Managers')
    expect(r.year).toBe(2022)
    expect(r.updated).toBe('2026-02-09T23:00:00+0100')
  })
})

describe('comparing with the market', () => {
  it('converts a basis only when it can', () => {
    expect(toGrossYear(185000, 'gross_year')).toBe(185000)
    expect(toGrossYear(5685, 'gross_month')).toBe(68220)
    // A net figure cannot become gross without the whole payroll calculation.
    expect(toGrossYear(9000, 'net_month')).toBeNull()
  })

  it('places a figure in the published band', () => {
    const band = { p25: 150000, p50: 185000, p75: 230000 }
    expect(position(140000, band).band).toBe('abaixo de p25')
    expect(position(170000, band).band).toBe('entre p25 e p50')
    expect(position(200000, band).band).toBe('entre p50 e p75')
    expect(position(250000, band).band).toBe('acima de p75')
    expect(position(185000, band).gapToMedian).toBe(0)
    expect(position(160000, band).gapToMedian).toBe(25000)
  })

  it('does not narrow a band the source never published', () => {
    const only50 = { p25: null, p50: 185000, p75: null }
    expect(position(140000, only50).band).toBe('entre p25 e p50')
    expect(position(300000, only50).band).toBe('entre p50 e p75')
    expect(position(1, { p25: null, p50: null, p75: null }).band).toBe('sem faixa')
  })

  it('keeps one reading per source and the whole history', () => {
    const role: BenchmarkRole = { id: 'r1', name: 'CIO regional', scope: 'regional', region: 'Europa', notes: '', sort: 0 }
    const e = (id: string, as_of: string, source: string, p50: number): BenchmarkEntry => ({
      id, role_id: 'r1', as_of, source, source_url: '', basis: 'gross_year', currency: 'EUR',
      p25: null, p50, p75: null, sample_size: null, official: false, notes: '',
    })
    const entries = [e('a', '2025-06-30', 'APEC', 170000), e('b', '2026-06-30', 'APEC', 185000), e('c', '2026-03-31', 'Glassdoor', 160000)]
    const cmp = compareRole(role, entries, 180000)
    // Two sources, so two current readings: APEC's newest, not its 2025 one.
    expect(cmp.latest).toHaveLength(2)
    expect(cmp.latest.find((l) => l.entry.source === 'APEC')!.entry.p50).toBe(185000)
    // History keeps every reading, oldest first.
    expect(cmp.history.map((h) => h.as_of)).toEqual(['2025-06-30', '2026-03-31', '2026-06-30'])
    expect(cmp.latest.find((l) => l.entry.source === 'Glassdoor')!.position!.band).toBe('entre p50 e p75')
  })

  it('reads own pay from twelve payslips, and says when it had to annualise one', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => ({ period: `2026-${String(i + 1).padStart(2, '0')}`, gross: 15000 }))
    expect(myGrossYear(twelve)).toMatchObject({ value: 180000, from: 'ano', months: 12 })
    const three = twelve.slice(0, 3)
    expect(myGrossYear(three)).toMatchObject({ value: 180000, from: 'mes', months: 3 })
    expect(myGrossYear([])).toMatchObject({ value: null, from: null })
  })
})

describe('reading a benchmark base from a file', () => {
  const roles: BenchmarkRole[] = [{ id: 'r1', name: 'CIO regional', scope: 'regional', region: 'Europa', notes: '', sort: 0 }]

  it('accepts the number formats a European table actually uses', () => {
    expect(parseAmount('185000')).toBe(185000)
    expect(parseAmount('185 000,50')).toBe(185000.5)
    expect(parseAmount('185.000,50')).toBe(185000.5)
    expect(parseAmount('185,000.50')).toBe(185000.5)
    expect(parseAmount('€185,000')).toBe(185000)
    expect(parseAmount('')).toBeNull()
  })

  it('accepts the date formats a European table actually uses', () => {
    expect(parseAsOf('2026-06-30')).toBe('2026-06-30')
    expect(parseAsOf('30/06/2026')).toBe('2026-06-30')
    expect(parseAsOf('2026-02')).toBe('2026-02-28') // last day of the month
    expect(parseAsOf('06/2026')).toBe('2026-06-30')
    expect(parseAsOf('ontem')).toBeNull()
  })

  it('reads a well-formed row', () => {
    const r = parseBenchmarkRows([{
      cargo: 'CIO regional', regiao: 'Europa', data: '2026-06-30', fonte: 'APEC',
      base: 'bruto_anual', moeda: 'EUR', p25: '150000', p50: '185000', p75: '230000', amostra: '120', oficial: 'nao',
    }], roles)
    expect(r.errors).toEqual([])
    expect(r.newRoles).toEqual([])
    expect(r.entries[0]).toMatchObject({ roleName: 'CIO regional', as_of: '2026-06-30', basis: 'gross_year', p50: 185000, sample_size: 120, official: false })
  })

  it('reports a bad row with its line number instead of dropping it', () => {
    const r = parseBenchmarkRows([
      { cargo: '', data: '2026-06-30', fonte: 'APEC', p50: '1' },
      { cargo: 'CIO regional', data: 'nunca', fonte: 'APEC', p50: '1' },
      { cargo: 'CIO regional', data: '2026-06-30', fonte: 'APEC', p50: '' },
    ], roles)
    expect(r.entries).toEqual([])
    expect(r.errors).toHaveLength(3)
    expect(r.errors[0]).toMatch(/linha 2.*cargo/)
    expect(r.errors[1]).toMatch(/linha 3.*data inválida/)
    expect(r.errors[2]).toMatch(/linha 4.*mediana/)
  })

  it('flags a role the file names but nobody tracks yet', () => {
    const r = parseBenchmarkRows([{ cargo: 'Head de Dados', regiao: 'Europa', data: '2026-06-30', fonte: 'X', p50: '118000' }], roles)
    expect(r.newRoles).toEqual([{ name: 'Head de Dados', region: 'Europa' }])
  })

  it('rejects a basis or currency it cannot honour', () => {
    const bad = parseBenchmarkRows([{ cargo: 'CIO regional', data: '2026-06-30', fonte: 'X', p50: '1', base: 'por hora' }], roles)
    expect(bad.errors[0]).toMatch(/base .* não reconhecida/)
    const usd = parseBenchmarkRows([{ cargo: 'CIO regional', data: '2026-06-30', fonte: 'X', p50: '1', moeda: 'USD' }], roles)
    expect(usd.errors[0]).toMatch(/moeda/)
  })

  it('ignores header case, accents and column order', () => {
    const r = parseBenchmarkRows([{ CARGO: 'CIO regional', Data: '30/06/2026', FONTE: 'APEC', P50: '185000', 'Observação': 'ok' }], roles)
    expect(r.errors).toEqual([])
    expect(r.entries[0]).toMatchObject({ as_of: '2026-06-30', notes: 'ok' })
  })
})
