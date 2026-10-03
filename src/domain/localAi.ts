import { buildExchangeRequest, parseExchangeAnswer, type VendorQuery, type VendorSuggestion } from './claudeExchange'
import type { LineDiff, TotalDiff } from './payroll'

/**
 * Prompts for the local model. Pure on purpose: the arithmetic is always done in code and
 * only handed to the model to put into words, so a weak model can word it badly but can
 * never change a number.
 */

/** A small local model answers better in batches; 12 merchants per call is a safe default. */
export const VENDOR_BATCH = 12

const VENDOR_SYSTEM = 'Você é um classificador de lançamentos bancários. Responda somente com JSON válido, sem comentários e sem texto fora do JSON.'

export function vendorPrompt(vendors: VendorQuery[], categories: string[]): { system: string; prompt: string } {
  // Same instructions and shape as the file exchange, so both paths are validated by the
  // same parser and a category outside the user's list is rejected either way.
  const req = buildExchangeRequest(vendors, categories)
  return {
    system: VENDOR_SYSTEM,
    prompt: [
      req.instrucoes,
      '',
      'Categorias permitidas (use exatamente estes nomes, ou null):',
      JSON.stringify(req.categorias),
      '',
      'Estabelecimentos:',
      JSON.stringify(req.estabelecimentos, null, 1),
      '',
      'Formato exato da resposta:',
      JSON.stringify(req.exemploDeResposta),
    ].join('\n'),
  }
}

/** Reuses the exchange parser, so an invented category becomes "unsure" instead of a new one. */
export function parseVendorAnswer(text: string, categories: string[], asked: Iterable<string>): VendorSuggestion[] {
  return parseExchangeAnswer(text, categories, asked)
}

const PAYSLIP_SYSTEM = 'Você explica holerites franceses para uma pessoa física, em português do Brasil, de forma direta e honesta.'

const eur = (n: number | null) =>
  n === null ? '—' : n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/**
 * Asks for an explanation of a payslip diff that was already computed. The numbers go in
 * as fact and the model is told not to recompute them: its job is the "why", not the maths.
 */
export function payslipPrompt(
  mesA: string, mesB: string, totals: TotalDiff[], lines: LineDiff[], gainDiff: number,
): { system: string; prompt: string } {
  const top = lines.slice(0, 25)
  const fmtLine = (l: LineDiff) =>
    `- ${l.code ? `[${l.code}] ` : ''}${l.label} (${l.field}): ${eur(l.a)} → ${eur(l.b)} = ${l.diff > 0 ? '+' : ''}${eur(l.diff)}` +
    (l.status === 'added' ? ' (linha nova neste mês)' : l.status === 'removed' ? ' (linha que existia antes e saiu)' : '')
  return {
    system: PAYSLIP_SYSTEM,
    prompt: [
      `Comparação de dois holerites já calculada pelo aplicativo. Mês A = ${mesA}, mês B = ${mesB}.`,
      'Os números abaixo são fatos conferidos. NÃO refaça as contas e NÃO cite números que não estejam aqui.',
      '',
      'Totais que mudaram:',
      ...totals.map((t) => `- ${t.label}: ${eur(t.a)} → ${eur(t.b)} = ${t.diff > 0 ? '+' : ''}${eur(t.diff)}`),
      '',
      `Soma das linhas de ganho (fora da linha /101, que é o próprio bruto): ${gainDiff > 0 ? '+' : ''}${eur(gainDiff)}`,
      '',
      `Linhas que mudaram${lines.length > top.length ? ` (as ${top.length} maiores de ${lines.length})` : ''}:`,
      ...top.map(fmtLine),
      '',
      'Os valores estão em EUROS (€). Nunca escreva R$ nem converta para outra moeda.',
      '',
      'Escreva, em no máximo 180 palavras:',
      '1. Em uma frase, o que mudou no bruto e qual linha explica isso.',
      '2. Em uma frase, o que mudou no líquido recebido e por quê (atenção: variação de bruto e variação de imposto são causas diferentes).',
      '3. Se algo merece conferência pelo titular, diga o quê. Se nada merecer, diga que está coerente.',
      '',
      'Limites, importante:',
      '- Não especule sobre causas que não estejam nas linhas acima. Não sugira mudança de contrato, de vínculo, de cargo nem de enquadramento.',
      '- A alíquota do PAS é definida pelo fisco francês e muda por fora do holerite: se ela mudou, diga apenas isso, sem adivinhar o motivo.',
      '- Não dê conselho fiscal e não invente regra de lei.',
      '- Se a causa de alguma mudança não estiver nas linhas acima, diga que ela não está no holerite.',
    ].join('\n'),
  }
}

/** Rules every narration shares: the model words the arithmetic, it never invents any. */
const LIMITES = [
  'Limites, importante:',
  '- Os números acima são fatos já conferidos. NÃO refaça nenhuma conta e NÃO cite número que não esteja na lista.',
  '- Não especule sobre causas que não estejam nos dados. Se a causa de algo não estiver aqui, diga que não está.',
  '- Não dê conselho financeiro, fiscal nem de investimento, e não invente regra de lei.',
  '- Não faça julgamento moral de gasto nenhum, nem comente estilo de vida.',
]

export interface AnalysisFacts {
  medida: 'expense' | 'income'
  moeda: string
  periodo: string
  comparacao: string | null
  total: number
  totalAnterior: number | null
  mediaMes: number
  lancamentos: number
  ticketMedio: number
  maior: { estabelecimento: string; valor: number; dia: string } | null
  fluxos: { receitas: number; despesas: number; resultado: number; taxaPoupanca: number | null } | null
  categorias: { nome: string; total: number; fatia: number }[]
  subiram: { nome: string; antes: number; agora: number; delta: number }[]
  cairam: { nome: string; antes: number; agora: number; delta: number }[]
  novos: { nome: string; total: number }[]
}

/**
 * Narration of the Analyses overview. Everything comes from what is already on screen,
 * including the comparison period, so the text and the tables cannot disagree.
 */
export function analysisPrompt(f: AnalysisFacts): { system: string; prompt: string } {
  const n = (v: number) => `${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${f.moeda}`
  const p = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`
  const o = f.medida === 'expense' ? 'gastos' : 'receitas'
  const linhas = [
    `Análise de ${o} de uma pessoa física. Período: ${f.periodo}.`,
    f.comparacao ? `Comparado com: ${f.comparacao}.` : 'Sem período de comparação.',
    '',
    `Total de ${o}: ${n(f.total)}` + (f.totalAnterior !== null ? ` (antes ${n(f.totalAnterior)}, ${p(f.total / (f.totalAnterior || 1) - 1)})` : ''),
    `Média por mês: ${n(f.mediaMes)}`,
    `Lançamentos: ${f.lancamentos} · valor médio ${n(f.ticketMedio)}`,
    f.maior ? `Maior lançamento: ${n(f.maior.valor)} em ${f.maior.estabelecimento} (${f.maior.dia})` : '',
  ]
  if (f.fluxos) {
    linhas.push(
      '',
      `Receitas no período: ${n(f.fluxos.receitas)}`,
      `Despesas no período: ${n(f.fluxos.despesas)}`,
      `Resultado: ${n(f.fluxos.resultado)}`,
      f.fluxos.taxaPoupanca === null ? '' : `Taxa de poupança: ${(f.fluxos.taxaPoupanca * 100).toFixed(1)}%`,
    )
  }
  if (f.categorias.length) {
    linhas.push('', 'Maiores categorias:', ...f.categorias.map((c) => `- ${c.nome}: ${n(c.total)} (${(c.fatia * 100).toFixed(1)}% do total)`))
  }
  if (f.subiram.length) {
    linhas.push('', 'Categorias que mais subiram:', ...f.subiram.map((c) => `- ${c.nome}: ${n(c.antes)} → ${n(c.agora)} (+${n(c.delta)})`))
  }
  if (f.cairam.length) {
    linhas.push('', 'Categorias que mais caíram:', ...f.cairam.map((c) => `- ${c.nome}: ${n(c.antes)} → ${n(c.agora)} (${n(c.delta)})`))
  }
  if (f.novos.length) {
    linhas.push('', 'Estabelecimentos que apareceram pela primeira vez no período:', ...f.novos.map((m) => `- ${m.nome}: ${n(m.total)}`))
  }
  linhas.push(
    '',
    'Escreva, em no máximo 160 palavras e sem listas longas:',
    '1. O que mais pesou no período e se o total subiu ou caiu em relação à comparação.',
    '2. As duas mudanças mais relevantes entre os períodos, nomeando as categorias.',
    '3. O que merece conferência (por exemplo, um estabelecimento novo com valor alto). Se nada merecer, diga que está estável.',
    '',
    ...LIMITES,
  )
  return { system: 'Você resume gastos e receitas de uma pessoa física, em português do Brasil, de forma direta e sem moralismo.', prompt: linhas.filter((l) => l !== '').join('\n') }
}

export interface InflationFacts {
  pais: string
  moeda: string
  de: string
  ate: string
  liquidoBase: number
  liquidoRecente: number
  variacaoNominal: number
  inflacao: number
  variacaoReal: number
  lacunaMensal: number
  picoValor: number | null
  picoMes: string
  anosEstimados: number[]
}

/**
 * Narration of pay against inflation. The gap is the number that matters and it is
 * already computed; the model must not re-derive it from the percentages.
 */
export function inflationPrompt(f: InflationFacts): { system: string; prompt: string } {
  const n = (v: number) => `${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${f.moeda}`
  const p = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`
  const linhas = [
    `Salário contra inflação, de ${f.de} a ${f.ate}. Inflação de referência: ${f.pais}.`,
    'A base é a média do líquido dos 3 primeiros holerites e o recente é a média dos 3 últimos, para um mês de bônus não distorcer.',
    '',
    `Líquido médio base: ${n(f.liquidoBase)}`,
    `Líquido médio recente: ${n(f.liquidoRecente)}`,
    `Variação nominal: ${p(f.variacaoNominal)}`,
    `Inflação acumulada no período: ${p(f.inflacao)}`,
    `Variação real (já descontada a inflação): ${p(f.variacaoReal)}`,
    f.lacunaMensal < 0
      ? `Perda de poder de compra: ${n(-f.lacunaMensal)} por mês`
      : `Ganho acima da inflação: ${n(f.lacunaMensal)} por mês`,
    f.picoValor === null ? '' : `Pico do líquido: ${n(f.picoValor)} em ${f.picoMes}`,
    f.anosEstimados.length ? `Atenção: a inflação de ${f.anosEstimados.join(', ')} é estimativa editável, não número oficial.` : '',
    '',
    'Escreva, em no máximo 140 palavras:',
    '1. Se o salário acompanhou a inflação ou não, e de quanto é a diferença por mês.',
    '2. Que o nominal subir não significa ganho real, se for o caso aqui.',
    '3. Se algum ano da inflação usada é estimativa, lembre que o resultado muda quando sair o número oficial.',
    '',
    ...LIMITES,
    '- Não sugira pedir aumento, trocar de emprego nem nada parecido: apenas descreva o que os números mostram.',
  ]
  return { system: 'Você explica a evolução de um salário contra a inflação, em português do Brasil, de forma direta e honesta.', prompt: linhas.filter((l) => l !== '').join('\n') }
}

export interface MarketFacts {
  cargo: string
  regiao: string
  moeda: string
  meuBrutoAno: number | null
  origemDoMeu: 'ano' | 'mes' | null
  leituras: {
    fonte: string
    data: string
    base: string
    oficial: boolean
    p25: number | null
    p50: number | null
    p75: number | null
    amostra: number | null
    faixa: string
    diferencaAteMediana: number | null
  }[]
  historico: { data: string; fonte: string; medianaAno: number }[]
}

/**
 * Narration of a market comparison. The hard rule here is different from the others: the
 * model must not produce a salary figure at all. A local model has no market data, and an
 * invented benchmark reads as authoritative while being worthless — so it may only reuse
 * the numbers listed, which came from sources the user wrote down.
 */
export function marketPrompt(f: MarketFacts): { system: string; prompt: string } {
  const n = (v: number | null) => (v === null ? 'não informado' : `${v.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} ${f.moeda}`)
  const linhas = [
    `Comparação de remuneração para o cargo "${f.cargo}"${f.regiao ? ` (${f.regiao})` : ''}.`,
    f.meuBrutoAno === null
      ? 'A remuneração atual do titular não está disponível.'
      : `Bruto anual atual do titular: ${n(f.meuBrutoAno)}`
        + (f.origemDoMeu === 'mes' ? ' (estimado a partir do último holerite multiplicado por 12, não de 12 meses reais).' : ' (soma de 12 holerites reais).'),
    '',
    'Leituras de mercado registradas pelo titular, cada uma com a sua fonte:',
    ...f.leituras.map((l) => `- ${l.fonte}${l.oficial ? ' (estatística oficial)' : ''}, de ${l.data}, base ${l.base}: `
      + `p25 ${n(l.p25)}, mediana ${n(l.p50)}, p75 ${n(l.p75)}`
      + (l.amostra ? `, amostra ${l.amostra}` : '')
      + `. Posição do titular: ${l.faixa}`
      + (l.diferencaAteMediana === null ? '.' : `, mediana ${l.diferencaAteMediana >= 0 ? 'acima' : 'abaixo'} em ${n(Math.abs(l.diferencaAteMediana))}.`)),
  ]
  if (f.historico.length > 1) {
    linhas.push('', 'Histórico das medianas registradas (bruto anual):',
      ...f.historico.map((h) => `- ${h.data} (${h.fonte}): ${n(h.medianaAno)}`))
  }
  linhas.push(
    '',
    'Escreva, em no máximo 150 palavras:',
    '1. Onde a remuneração do titular está em relação às leituras registradas.',
    '2. Se as fontes discordam entre si, diga isso e com que números.',
    '3. O que limita a leitura (fonte antiga, amostra pequena, base diferente, uma única fonte).',
    '',
    'Limites, importante:',
    '- NUNCA cite um valor de salário que não esteja na lista acima. Você não tem dados de mercado próprios.',
    '- Se faltar informação para concluir, diga que falta. Não estime, não arredonde para um "valor de mercado" e não invente faixa.',
    '- Não compare com empresas, pessoas ou cargos que não estejam listados.',
    '- Não aconselhe pedir aumento, negociar, mudar de emprego nem aceitar proposta: apenas descreva o que os números mostram.',
    '- Uma estatística oficial por ocupação (como a do Eurostat) cobre um grupo amplo de profissões, não um cargo específico: trate-a como âncora, não como grupo de pares.',
  )
  return {
    system: 'Você compara uma remuneração com referências de mercado que lhe são fornecidas, em português do Brasil. Você não possui dados de mercado próprios e nunca inventa valores.',
    prompt: linhas.join('\n'),
  }
}

export interface ResearchFacts {
  cargos: { nome: string; regiao: string; abrangencia: string; leituras: number; fontesUsadas: string[]; maisRecente: string | null }[]
  paises: string[]
  oficial: { pais: string; porte: string; mediaMes: number | null }[]
  anoOficial: number
  ocupacaoOficial: string
  moeda: string
  meuBrutoAno: number | null
}

/**
 * Asks the model to propose how to research the market — not to answer it. This is the
 * one place a local model is genuinely useful on this subject: it has no salary data, but
 * it can lay out which sources to consult per country and what is missing from what has
 * already been recorded.
 */
export function marketResearchPrompt(f: ResearchFacts): { system: string; prompt: string } {
  const n = (v: number | null) => (v === null ? 'não publicado' : `${v.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} ${f.moeda}/mês`)
  const linhas = [
    'Contexto: uma pessoa física acompanha a própria remuneração contra o mercado e quer um plano de pesquisa.',
    `Países de interesse: ${f.paises.join(', ')}.`,
    f.meuBrutoAno === null ? 'A remuneração atual não está disponível.' : `Bruto anual atual: ${f.meuBrutoAno.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} ${f.moeda}.`,
    '',
    'Cargos acompanhados e o que já foi registrado:',
    ...f.cargos.map((c) => `- ${c.nome} (${c.abrangencia}${c.regiao ? `, ${c.regiao}` : ''}): ${c.leituras} leitura(s)`
      + (c.fontesUsadas.length ? `, fontes: ${c.fontesUsadas.join(', ')}` : ', nenhuma fonte ainda')
      + (c.maisRecente ? `, mais recente de ${c.maisRecente}` : '')),
    '',
    `Âncora oficial disponível (Eurostat, ${f.ocupacaoOficial}, ${f.anoOficial}, ganho mensal bruto médio):`,
    ...f.oficial.map((o) => `- ${o.pais}, empresas ${o.porte}: ${n(o.mediaMes)}`),
    '',
    'Proponha um plano de análise de mercado, em no máximo 220 palavras:',
    '1. Que fontes consultar por país, nomeando as que existem de fato para executivos de TI na Europa ocidental',
    '   (por exemplo estudos de associações de cadres, convenções coletivas setoriais, consultorias de recrutamento,',
    '   institutos de estatística). Diga o que cada tipo de fonte mede e com que frequência sai.',
    '2. Que lacunas existem no que já foi registrado: país sem leitura, fonte única, dado velho, base incomparável.',
    '3. Como tornar as leituras comparáveis entre países (bruto x líquido, custo de vida, paridade de poder de compra,',
    '   13º/14º salário onde existe, bônus e benefícios dentro ou fora do número).',
    '',
    'Limites, importante:',
    '- NUNCA invente um valor de salário. Você não tem dados de mercado. Só pode repetir os números listados acima.',
    '- Não afirme o que uma fonte publica hoje se não tiver certeza: diga "verificar" em vez de inventar um número ou uma data.',
    '- Não dê conselho de carreira, de negociação salarial nem de mudança de emprego.',
    '- Não cite links: apenas nomeie o tipo de fonte e o que procurar nela.',
  ]
  return {
    system: 'Você ajuda a planejar uma pesquisa de remuneração de mercado. Você não possui dados salariais e nunca inventa valores nem datas de publicação.',
    prompt: linhas.join('\n'),
  }
}
