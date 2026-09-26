import { describe, expect, it } from 'vitest'
import { buildExchangeRequest, EXCHANGE_FORMAT, parseExchangeAnswer, type VendorQuery } from '../src/domain/claudeExchange'

const CATS = ['Mercado', 'Restaurantes', 'Taxas bancárias']
const vendor: VendorQuery = { merchant: 'LISBON DUTY FREE', samples: ['COMPRA 8695 LISBON DUTY FREE PIE LI CONTACTLESS'], sign: 'debit', currency: 'EUR', typicalAmount: 59.5 }

describe('Claude file exchange', () => {
  it('exports the merchants, the sorted category list and the answer format', () => {
    const req = buildExchangeRequest([vendor], ['Taxas bancárias', 'Mercado'])
    expect(req.formato).toBe(EXCHANGE_FORMAT)
    expect(req.categorias).toEqual(['Mercado', 'Taxas bancárias'])
    expect(req.estabelecimentos).toEqual([vendor])
    expect(req.instrucoes).toContain('EXATAMENTE')
  })

  it('reads an answer and keeps only categories from the user list', () => {
    const answer = JSON.stringify({
      formato: EXCHANGE_FORMAT,
      resultados: [
        { merchant: 'LISBON DUTY FREE', category: 'Mercado', description: 'Loja duty free do aeroporto de Lisboa', confidence: 0.7 },
        { merchant: 'COM MAN CONTA', category: 'Tarifas', description: 'Comissão de manutenção', confidence: 0.9 },
      ],
    })
    const out = parseExchangeAnswer(answer, CATS)
    expect(out[0]).toEqual({ merchant: 'LISBON DUTY FREE', category: 'Mercado', description: 'Loja duty free do aeroporto de Lisboa', confidence: 0.7 })
    expect(out[1].category).toBeNull() // "Tarifas" is not one of the user's categories
  })

  it('accepts a bare array in a code fence and clamps confidence', () => {
    const out = parseExchangeAnswer('```json\n[{"merchant":"X","category":null,"description":"?","confidence":3}]\n```', CATS)
    expect(out).toEqual([{ merchant: 'X', category: null, description: '?', confidence: 1 }])
  })

  it('ignores merchants that were not exported and rejects answers with none left', () => {
    const answer = '[{"merchant":"OTHER","category":"Mercado","description":"","confidence":0.9}]'
    expect(() => parseExchangeAnswer(answer, CATS, ['LISBON DUTY FREE'])).toThrow(/Nenhum estabelecimento/)
    expect(() => parseExchangeAnswer('not json', CATS)).toThrow(/JSON válido/)
    expect(() => parseExchangeAnswer('{"foo":1}', CATS)).toThrow(/resultados/)
  })
})
