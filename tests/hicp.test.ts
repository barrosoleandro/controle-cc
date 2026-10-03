import { describe, expect, it } from 'vitest'
import { HICP_GEO, hicpUrl, mergeOfficial, parseHicp, type JsonStat } from '../src/domain/hicp'

// The real answer for geo=FR, sinceTimePeriod=2021, captured from the Eurostat API.
const FR: JsonStat = {
  label: 'HICP - annual data (average index and rate of change) (1996-2025)',
  updated: '2026-02-06T23:00:00+0100',
  id: ['freq', 'unit', 'coicop', 'geo', 'time'],
  size: [1, 1, 1, 1, 5],
  value: { 0: 2.1, 1: 5.9, 2: 5.7, 3: 2.3, 4: 0.9 },
  dimension: {
    time: { category: { index: { 2021: 0, 2022: 1, 2023: 2, 2024: 3, 2025: 4 } } },
    geo: { category: { index: { FR: 0 } } },
  },
}

describe('official inflation from Eurostat', () => {
  it('builds the documented query', () => {
    const u = hicpUrl('FR', 2021)
    expect(u).toContain('prc_hicp_aind')
    expect(u).toContain('unit=RCH_A_AVG') // annual average rate of change, not the index
    expect(u).toContain('coicop=CP00') // all items
    expect(u).toContain('geo=FR')
    expect(u).toContain('sinceTimePeriod=2021')
  })

  it('reads the real answer into year → rate', () => {
    const r = parseHicp(FR)
    expect(r.rates).toEqual({ 2021: 2.1, 2022: 5.9, 2023: 5.7, 2024: 2.3, 2025: 0.9 })
    expect(r.lastYear).toBe(2025)
    expect(r.updated).toBe('2026-02-06T23:00:00+0100')
  })

  it('resolves the year through the time dimension, not by array position', () => {
    // A year still unpublished is simply absent from value, not null-padded.
    const sparse: JsonStat = { ...FR, value: { 0: 2.1, 2: 5.7 } }
    expect(parseHicp(sparse).rates).toEqual({ 2021: 2.1, 2023: 5.7 })
  })

  it('accepts value as an array as well as a keyed object', () => {
    expect(parseHicp({ ...FR, value: [2.1, 5.9, 5.7, 2.3, 0.9] }).rates[2022]).toBe(5.9)
  })

  it('skips nulls instead of turning them into zero inflation', () => {
    const withNull: JsonStat = { ...FR, value: { 0: 2.1, 1: null, 2: 5.7, 3: 2.3, 4: 0.9 } }
    const r = parseHicp(withNull)
    expect(r.rates[2022]).toBeUndefined()
    expect(Object.keys(r.rates)).toHaveLength(4)
  })

  it('fails loudly on an answer it cannot read', () => {
    expect(() => parseHicp({})).toThrow(/tempo/i)
    expect(() => parseHicp({ ...FR, id: ['freq', 'unit', 'coicop', 'geo'] })).toThrow(/time/i)
    expect(() => parseHicp({ ...FR, value: {} })).toThrow(/sem nenhum valor/i)
  })

  it('keeps the user figures for years Eurostat has not published', () => {
    const mine = { 2024: 2.0, 2025: 1.0, 2026: 1.5 }
    const merged = mergeOfficial(mine, { 2024: 2.3, 2025: 0.9 })
    expect(merged).toEqual({ 2024: 2.3, 2025: 0.9, 2026: 1.5 })
  })

  it('only claims the countries Eurostat actually covers', () => {
    expect(HICP_GEO['França']).toBe('FR')
    expect(HICP_GEO['Portugal']).toBe('PT')
    expect(HICP_GEO['Brasil']).toBeUndefined() // IPCA is not an Eurostat series
  })
})
