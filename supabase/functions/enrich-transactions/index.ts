// Edge Function: asks Claude to identify unknown merchants during an import.
//
// The ANTHROPIC_API_KEY lives here as a Supabase secret — the browser never sees it.
// Set it once with:  supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//
// It answers with, per merchant, a category taken from the user's own list and a
// one-line description of what the vendor sells. Nothing is written to the
// database here: the client shows the suggestions and the user accepts them.
import Anthropic from 'npm:@anthropic-ai/sdk@0.128.0'

const MODEL = 'claude-opus-5'
const MAX_VENDORS = 60 // one import batch; the client chunks larger lists
const UNSURE = '?'

interface Vendor {
  merchant: string
  samples: string[]
  bankCategory?: string | null
  bankSubcategory?: string | null
  sign: 'debit' | 'credit'
  currency: string
  typicalAmount?: number
}

interface Body {
  vendors: Vendor[]
  categories: string[]
}

const cors = {
  'Access-Control-Allow-Origin': '*', // safe: every call still needs a valid aal2 JWT
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

/** The RLS policies require an MFA-verified session; this endpoint holds the same line. */
function assuranceLevel(authHeader: string | null): string | null {
  const token = authHeader?.replace(/^Bearer\s+/i, '')
  if (!token) return null
  try {
    const payload = token.split('.')[1]
    const pad = '='.repeat((4 - (payload.length % 4)) % 4)
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/') + pad))
    return typeof decoded.aal === 'string' ? decoded.aal : null
  } catch { return null }
}

const SYSTEM = `Você classifica lançamentos bancários de uma pessoa física (contas na França, em EUR, e no Brasil, em BRL).

Para cada estabelecimento você recebe: a chave do estabelecimento, trechos reais de descrições do extrato, a categoria que o próprio banco atribuiu (quando existe), o sinal (debit = saída, credit = entrada) e a moeda.

Regras:
- "categoria" deve ser EXATAMENTE um dos nomes fornecidos na lista do usuário. Se nenhum servir ou você não tiver certeza razoável, responda "${UNSURE}".
- "descricao" diz o que o estabelecimento vende, em português do Brasil, em uma frase curta (até 120 caracteres), sem repetir o valor nem a data. Descreva o produto/serviço, não o lançamento. Se o estabelecimento for desconhecido, descreva o que a descrição do extrato indica e deixe claro que é incerto.
- "confianca" é de 0 a 1 e deve refletir honestamente sua certeza sobre a categoria.
- Descrições de extrato são truncadas e cheias de abreviação. Não invente marcas que não estão ali.`

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405)

  if (assuranceLevel(req.headers.get('Authorization')) !== 'aal2')
    return json({ error: 'Sessão sem verificação em duas etapas.' }, 403)

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY não configurada na Edge Function.' }, 500)

  let body: Body
  try { body = await req.json() } catch { return json({ error: 'JSON inválido.' }, 400) }
  const vendors = (body.vendors ?? []).slice(0, MAX_VENDORS)
  const categories = body.categories ?? []
  if (!vendors.length) return json({ results: [] })
  if (!categories.length) return json({ error: 'Lista de categorias vazia.' }, 400)

  const client = new Anthropic({ apiKey })
  // Strict tool use with the category list as an enum: the answer cannot name a
  // category that does not exist, so the client never has to guess what it meant.
  const tool: Anthropic.Tool = {
    name: 'registrar_classificacao',
    description: 'Registra a categoria e a descrição de cada estabelecimento.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        itens: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              estabelecimento: { type: 'string', description: 'a chave recebida, copiada sem alterar' },
              categoria: { type: 'string', enum: [...categories, UNSURE] },
              descricao: { type: 'string' },
              confianca: { type: 'number' },
            },
            required: ['estabelecimento', 'categoria', 'descricao', 'confianca'],
            additionalProperties: false,
          },
        },
      },
      required: ['itens'],
      additionalProperties: false,
    },
  }

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      thinking: { type: 'adaptive' },
      // Classification repays low effort; raise it here if the categories get subtler.
      output_config: { effort: 'low' },
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
      messages: [{
        role: 'user',
        content: `Categorias disponíveis (use exatamente estes nomes):\n${categories.map((c) => `- ${c}`).join('\n')}\n\nEstabelecimentos:\n${JSON.stringify(vendors, null, 1)}`,
      }],
    })

    if (response.stop_reason === 'refusal')
      return json({ error: 'O modelo recusou a requisição.', details: response.stop_details }, 502)

    const call = response.content.find((b) => b.type === 'tool_use')
    if (!call || call.type !== 'tool_use') return json({ error: 'Resposta do modelo sem classificação.' }, 502)
    // Tool inputs are JSON — parsed by the SDK, never string-matched.
    const itens = (call.input as { itens?: unknown[] }).itens ?? []

    return json({
      results: itens.map((raw) => {
        const i = raw as Record<string, unknown>
        const categoria = String(i.categoria ?? UNSURE)
        return {
          merchant: String(i.estabelecimento ?? ''),
          category: categoria === UNSURE || !categories.includes(categoria) ? null : categoria,
          description: String(i.descricao ?? '').slice(0, 300),
          confidence: Number(i.confianca ?? 0),
        }
      }).filter((r) => r.merchant),
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        model: response.model,
      },
    })
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return json({ error: 'Limite de uso da API atingido. Tente de novo em instantes.' }, 429)
    if (e instanceof Anthropic.AuthenticationError) return json({ error: 'ANTHROPIC_API_KEY inválida.' }, 500)
    if (e instanceof Anthropic.APIError) return json({ error: `Erro da API (${e.status}): ${e.message}` }, 502)
    return json({ error: (e as Error).message }, 500)
  }
})
