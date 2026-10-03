import { describe, expect, it } from 'vitest'
import { normalizeUrl, ollamaReady, DEFAULT_OLLAMA } from '../src/lib/ollama'
import { parseVendorAnswer, payslipPrompt, vendorPrompt, VENDOR_BATCH } from '../src/domain/localAi'
import type { VendorQuery } from '../src/domain/claudeExchange'
import type { LineDiff, TotalDiff } from '../src/domain/payroll'

const vendor = (merchant: string): VendorQuery => ({
  merchant, samples: [`CB ${merchant} FACT 120725`], sign: 'debit', currency: 'EUR', typicalAmount: 20,
})
const CATS = ['Padaria', 'Mercado', 'Streaming']

describe('ollama config, kept per device', () => {
  it('absorbs the two addresses people actually paste', () => {
    expect(normalizeUrl('http://localhost:11434/')).toBe('http://localhost:11434')
    expect(normalizeUrl('http://localhost:11434/api')).toBe('http://localhost:11434')
    expect(normalizeUrl('http://localhost:11434/api/chat')).toBe('http://localhost:11434')
    expect(normalizeUrl('  localhost:11434  ')).toBe('http://localhost:11434')
    expect(normalizeUrl('192.168.1.50:11434')).toBe('http://192.168.1.50:11434')
    expect(normalizeUrl('https://ollama.casa')).toBe('https://ollama.casa')
    expect(normalizeUrl('')).toBe('')
  })

  it('is only called once the address and the model are both set', () => {
    expect(ollamaReady(DEFAULT_OLLAMA)).toBe(false) // disabled by default
    expect(ollamaReady({ url: 'http://localhost:11434', model: '', enabled: true })).toBe(false)
    expect(ollamaReady({ url: '', model: 'llama3.1:8b', enabled: true })).toBe(false)
    expect(ollamaReady({ url: 'http://localhost:11434', model: 'llama3.1:8b', enabled: false })).toBe(false)
    expect(ollamaReady({ url: 'http://localhost:11434', model: 'llama3.1:8b', enabled: true })).toBe(true)
  })
})

describe('vendor prompt for the local model', () => {
  it('carries the merchants and the allowed category names', () => {
    const { prompt, system } = vendorPrompt([vendor('TEKEL PARIS')], CATS)
    expect(system).toMatch(/somente com JSON/i)
    expect(prompt).toContain('TEKEL PARIS')
    for (const c of CATS) expect(prompt).toContain(c)
  })

  it('batches small enough for a local model', () => {
    expect(VENDOR_BATCH).toBeGreaterThan(0)
    expect(VENDOR_BATCH).toBeLessThanOrEqual(25)
  })
})

describe('reading what the local model answered', () => {
  const asked = ['TEKEL PARIS']
  const answer = (body: unknown) => JSON.stringify(body)

  it('accepts the documented shape', () => {
    const out = parseVendorAnswer(answer({
      resultados: [{ merchant: 'TEKEL PARIS', category: 'Padaria', description: 'Tabacaria e padaria', confidence: 0.9 }],
    }), CATS, asked)
    expect(out).toEqual([{ merchant: 'TEKEL PARIS', category: 'Padaria', description: 'Tabacaria e padaria', confidence: 0.9 }])
  })

  it('survives a model that wraps the JSON in a code fence', () => {
    const fenced = '```json\n' + answer([{ merchant: 'TEKEL PARIS', category: 'Padaria', description: 'x', confidence: 1 }]) + '\n```'
    expect(parseVendorAnswer(fenced, CATS, asked)[0].category).toBe('Padaria')
  })

  it('refuses a category the user does not have, instead of inventing one', () => {
    const out = parseVendorAnswer(answer([
      { merchant: 'TEKEL PARIS', category: 'Tabacaria', description: 'x', confidence: 0.9 },
    ]), CATS, asked)
    expect(out[0].category).toBeNull()
  })

  it('ignores merchants that were never asked about', () => {
    expect(() => parseVendorAnswer(answer([
      { merchant: 'OUTRO LUGAR', category: 'Padaria', description: 'x', confidence: 1 },
    ]), CATS, asked)).toThrow(/corresponde/i)
  })

  it('clamps a nonsense confidence instead of trusting it', () => {
    const out = parseVendorAnswer(answer([
      { merchant: 'TEKEL PARIS', category: 'Padaria', description: 'x', confidence: 42 },
    ]), CATS, asked)
    expect(out[0].confidence).toBe(1)
  })

  it('fails loudly on text that is not JSON', () => {
    expect(() => parseVendorAnswer('desculpe, não sei responder', CATS, asked)).toThrow(/JSON/i)
  })
})

describe('payslip explanation prompt', () => {
  const totals: TotalDiff[] = [
    { key: 'gross', label: 'Bruto', a: 15388.61, b: 14767.66, diff: -620.95 },
    { key: 'net_paid', label: 'Líquido pago', a: 11623.2, b: 10321.59, diff: -1301.61 },
  ]
  const lines: LineDiff[] = [
    { code: '1390', label: 'Régul. Congés Payés', field: 'gain', a: 477.65, b: 0, diff: -477.65, status: 'removed' },
  ]

  it('states the numbers as fact and forbids recomputing them', () => {
    const { prompt } = payslipPrompt('ago/26', 'set/26', totals, lines, -620.95)
    expect(prompt).toMatch(/NÃO refaça as contas/)
    expect(prompt).toMatch(/NÃO cite números que não estejam aqui/)
    expect(prompt).toContain('Régul. Congés Payés')
    expect(prompt).toContain('ago/26')
    expect(prompt).toContain('set/26')
  })

  it('separates the gross change from the tax change, so the two are not conflated', () => {
    const { prompt } = payslipPrompt('ago/26', 'set/26', totals, lines, -620.95)
    expect(prompt).toMatch(/causas diferentes/)
  })

  it('caps how many lines it sends and says it truncated', () => {
    const many: LineDiff[] = Array.from({ length: 40 }, (_, i) => ({
      code: String(i), label: `Linha ${i}`, field: 'gain', a: 0, b: i, diff: i, status: 'changed',
    }))
    const { prompt } = payslipPrompt('a', 'b', totals, many, 0)
    expect(prompt).toMatch(/as 25 maiores de 40/)
    expect(prompt).not.toContain('Linha 39')
  })
})
