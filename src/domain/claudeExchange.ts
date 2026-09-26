/**
 * File exchange for categorizing merchants with Claude outside the app (Claude Code or
 * claude.ai, on the user's own plan): the app exports the unknown merchants as JSON,
 * Claude writes an answer file, the app reads it back into the usual review table.
 */

/** One merchant sent for identification, described only by what the statement already shows. */
export interface VendorQuery {
  merchant: string
  samples: string[]
  bankCategory?: string | null
  bankSubcategory?: string | null
  sign: 'debit' | 'credit'
  currency: string
  typicalAmount?: number
}

export interface VendorSuggestion {
  merchant: string
  category: string | null // a name from the user's own list, or null when unsure
  description: string
  confidence: number
}

export const EXCHANGE_FORMAT = 'controle-cc/categorias@1'

const INSTRUCTIONS = `Você classifica lançamentos bancários de uma pessoa física (contas na França, em EUR, e no Brasil, em BRL).

Para cada item de "estabelecimentos" há: a chave do estabelecimento ("merchant"), trechos reais de descrições do extrato ("samples"), a categoria que o próprio banco atribuiu (quando existe), o sinal (debit = saída, credit = entrada), a moeda e o valor típico.

Responda com um arquivo JSON no formato de "exemploDeResposta", com um item por estabelecimento:
- "merchant": copie exatamente a chave recebida.
- "category": EXATAMENTE um dos nomes de "categorias". Se nenhum servir ou você não tiver certeza razoável, use null.
- "description": o que o estabelecimento vende, em português do Brasil, em uma frase curta (até 120 caracteres), sem valor nem data. Se for desconhecido, descreva o que o extrato indica e deixe claro que é incerto.
- "confidence": de 0 a 1, refletindo honestamente sua certeza sobre a categoria.
Descrições de extrato são truncadas e cheias de abreviação. Não invente marcas que não estão ali.`

export function buildExchangeRequest(vendors: VendorQuery[], categories: string[]) {
  return {
    formato: EXCHANGE_FORMAT,
    instrucoes: INSTRUCTIONS,
    categorias: [...categories].sort((a, b) => a.localeCompare(b)),
    estabelecimentos: vendors,
    exemploDeResposta: {
      formato: EXCHANGE_FORMAT,
      resultados: [{ merchant: 'CHAVE DO ESTABELECIMENTO', category: 'Nome da categoria ou null', description: 'O que vende', confidence: 0.8 }],
    },
  }
}

/**
 * Reads Claude's answer. Tolerates a bare array or a code-fenced paste; a category that is
 * not one of the user's own names becomes null (unsure) rather than a new category.
 */
export function parseExchangeAnswer(text: string, categories: string[], asked?: Iterable<string>): VendorSuggestion[] {
  const body = text.replace(/^﻿/, '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { throw new Error('O arquivo de resposta não é um JSON válido.') }
  const list = Array.isArray(parsed) ? parsed : (parsed as { resultados?: unknown })?.resultados
  if (!Array.isArray(list)) throw new Error('Resposta sem a lista "resultados".')

  const known = new Set(categories)
  const wanted = asked ? new Set(asked) : null
  const out = new Map<string, VendorSuggestion>()
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const merchant = typeof r.merchant === 'string' ? r.merchant.trim() : ''
    if (!merchant || (wanted && !wanted.has(merchant))) continue
    const category = typeof r.category === 'string' && known.has(r.category.trim()) ? r.category.trim() : null
    const conf = Number(r.confidence)
    out.set(merchant, {
      merchant,
      category,
      description: typeof r.description === 'string' ? r.description.trim().slice(0, 200) : '',
      confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0.5,
    })
  }
  if (!out.size) throw new Error('Nenhum estabelecimento da resposta corresponde aos exportados.')
  return [...out.values()]
}

/** Marker kept in a transaction's notes while its category is the one Claude chose. */
export const AI_NOTE = 'Categoria definida pela IA'

/** Adds or removes the marker, keeping whatever the user wrote in the notes. */
export function withAiNote(notes: string | null | undefined, on: boolean): string {
  const rest = (notes ?? '').split(' · ').map((p) => p.trim()).filter((p) => p && p !== AI_NOTE)
  return (on ? [...rest, AI_NOTE] : rest).join(' · ')
}
