export type Risco = 'conservador' | 'moderado' | 'arrojado'
export type Regiao = 'BR' | 'EU'
export type Classe = 'reserva' | 'renda_fixa' | 'acoes' | 'imoveis' | 'previdencia'

export interface Veiculo {
  id: string
  nome: string
  regiao: Regiao
  classe: Classe
  liquidez: string
  risco: 'baixo' | 'medio' | 'alto'
  /** Regra geral, não cálculo: as regras mudam, confirme antes de decidir. */
  tributacao: string
  /** Premissa de retorno real (acima da inflação) ao ano. Editável na tela. */
  retornoReal: number
  observacao: string
}

/**
 * Tipos de investimento disponíveis no Brasil e na França/zona do euro.
 * É um catálogo de categorias, de propósito: nenhum ativo, corretora ou papel
 * específico é indicado aqui.
 */
export const VEICULOS: Veiculo[] = [
  // ---- Europa / França ----
  {
    id: 'livret_a', nome: 'Livret A / LDDS', regiao: 'EU', classe: 'reserva',
    liquidez: 'imediata', risco: 'baixo',
    tributacao: 'isento de imposto de renda e de contribuições sociais',
    retornoReal: 0,
    observacao: 'Taxa e teto de depósito definidos pelo Estado. Serve como reserva, não como investimento de longo prazo: costuma empatar com a inflação.',
  },
  {
    id: 'fonds_euro', nome: 'Fonds euros (dentro de assurance-vie)', regiao: 'EU', classe: 'renda_fixa',
    liquidez: 'dias a semanas', risco: 'baixo',
    tributacao: 'vantagem fiscal do envelope cresce com o tempo de contrato',
    retornoReal: 0.5,
    observacao: 'Capital garantido pela seguradora na maioria dos contratos. Cuidado com a taxa de administração, que come boa parte do rendimento.',
  },
  {
    id: 'pea_etf', nome: 'ETF de índice amplo dentro do PEA', regiao: 'EU', classe: 'acoes',
    liquidez: 'dias (com custo fiscal se sacar cedo)', risco: 'alto',
    tributacao: 'ganho isento de IR após 5 anos de conta, mantidas as contribuições sociais',
    retornoReal: 5,
    observacao: 'Envelope mais eficiente para ações na França. Limitado a ativos elegíveis (sobretudo europeus); há ETFs que replicam índices globais de forma sintética.',
  },
  {
    id: 'cto_etf', nome: 'ETF / ações em compte-titres (CTO)', regiao: 'EU', classe: 'acoes',
    liquidez: 'dias', risco: 'alto',
    tributacao: 'PFU (imposto único) sobre o ganho, salvo opção pela tabela progressiva',
    retornoReal: 5,
    observacao: 'Sem limite de aporte nem de ativo. Use quando o PEA já estiver no teto ou o ativo não for elegível a ele.',
  },
  {
    id: 'per', nome: 'PER (previdência)', regiao: 'EU', classe: 'previdencia',
    liquidez: 'travado até a aposentadoria, com exceções', risco: 'medio',
    tributacao: 'aporte dedutível do rendimento tributável, tributado na saída',
    retornoReal: 3.5,
    observacao: 'Vale mais quanto maior a sua faixa de imposto hoje. O dinheiro fica preso: não é lugar para a sobra que você pode precisar.',
  },
  // ---- Brasil ----
  {
    id: 'tesouro_selic', nome: 'Tesouro Selic', regiao: 'BR', classe: 'reserva',
    liquidez: 'D+1', risco: 'baixo',
    tributacao: 'IR regressivo sobre o rendimento, conforme o prazo',
    retornoReal: 1,
    observacao: 'Pós-fixado e sem sustos de marcação a mercado. É o padrão para reserva de emergência em reais.',
  },
  {
    id: 'tesouro_ipca', nome: 'Tesouro IPCA+', regiao: 'BR', classe: 'renda_fixa',
    liquidez: 'D+1, mas com marcação a mercado', risco: 'medio',
    tributacao: 'IR regressivo sobre o rendimento',
    retornoReal: 6,
    observacao: 'Trava um juro real contratado se levado ao vencimento. Vender antes pode dar prejuízo quando os juros sobem.',
  },
  {
    id: 'cdb_lci', nome: 'CDB, LCI e LCA', regiao: 'BR', classe: 'renda_fixa',
    liquidez: 'da diária à carência longa', risco: 'baixo',
    tributacao: 'CDB tem IR; LCI e LCA são isentas para pessoa física',
    retornoReal: 2.5,
    observacao: 'Protegido pelo FGC até o limite por instituição e por CPF. Compare sempre o líquido, não o "% do CDI".',
  },
  {
    id: 'acoes_br', nome: 'Ações na B3', regiao: 'BR', classe: 'acoes',
    liquidez: 'D+2', risco: 'alto',
    tributacao: 'ganho de capital tributado; dividendos e vendas pequenas têm regras próprias',
    retornoReal: 5.5,
    observacao: 'Concentrado em poucos setores. Morando fora, verifique também a sua situação de residência fiscal antes de montar posição.',
  },
  {
    id: 'fii', nome: 'FIIs (fundos imobiliários)', regiao: 'BR', classe: 'imoveis',
    liquidez: 'D+2', risco: 'alto',
    tributacao: 'rendimento mensal isento para pessoa física se cumpridas as condições legais',
    retornoReal: 4.5,
    observacao: 'Renda mensal com preço que oscila como ação. O risco é do imóvel e do inquilino, não some por ser "imobiliário".',
  },
  {
    id: 'etf_br', nome: 'ETF de índice na B3', regiao: 'BR', classe: 'acoes',
    liquidez: 'D+2', risco: 'alto',
    tributacao: 'IR sobre o ganho, sem a isenção de vendas pequenas das ações',
    retornoReal: 5,
    observacao: 'Forma mais simples de comprar um índice inteiro, inclusive de bolsa estrangeira, sem sair do real.',
  },
]

/** Fatia de cada classe por perfil, já descontada a reserva de emergência. */
export const ALOCACAO: Record<Risco, Record<Classe, number>> = {
  conservador: { reserva: 0.20, renda_fixa: 0.60, acoes: 0.15, imoveis: 0.05, previdencia: 0 },
  moderado: { reserva: 0.10, renda_fixa: 0.40, acoes: 0.35, imoveis: 0.10, previdencia: 0.05 },
  arrojado: { reserva: 0.05, renda_fixa: 0.20, acoes: 0.55, imoveis: 0.10, previdencia: 0.10 },
}

export const CLASSE_NOME: Record<Classe, string> = {
  reserva: 'Reserva / liquidez',
  renda_fixa: 'Renda fixa',
  acoes: 'Ações e ETFs',
  imoveis: 'Imóveis',
  previdencia: 'Previdência',
}

/** Quanto deveria estar parado e disponível antes de investir o resto. */
export function reservaRecomendada(despesaMensal: number, meses = 6) {
  return Math.max(0, despesaMensal) * meses
}

/** Retorno real médio da carteira, ponderado pela alocação do perfil. */
export function retornoRealCarteira(risco: Risco, veiculos: Veiculo[] = VEICULOS): number {
  const pesos = ALOCACAO[risco]
  let soma = 0, total = 0
  for (const [classe, peso] of Object.entries(pesos) as [Classe, number][]) {
    if (peso <= 0) continue
    const doGrupo = veiculos.filter((v) => v.classe === classe)
    if (!doGrupo.length) continue
    const medio = doGrupo.reduce((s, v) => s + v.retornoReal, 0) / doGrupo.length
    soma += medio * peso
    total += peso
  }
  return total ? soma / total : 0
}

export interface PontoProjecao { ano: number; aportado: number; valor: number }

/**
 * Projeção em moeda de hoje: o retorno usado é real, então o resultado já está
 * descontado da inflação e não precisa ser "corrigido" depois.
 */
export function projetar(aporteMensal: number, anos: number, retornoRealAnual: number, inicial = 0): PontoProjecao[] {
  const i = Math.pow(1 + retornoRealAnual / 100, 1 / 12) - 1
  let valor = inicial
  let aportado = inicial
  const out: PontoProjecao[] = [{ ano: 0, aportado, valor }]
  for (let ano = 1; ano <= anos; ano++) {
    for (let m = 0; m < 12; m++) {
      valor = valor * (1 + i) + aporteMensal
      aportado += aporteMensal
    }
    out.push({ ano, aportado: Math.round(aportado), valor: Math.round(valor) })
  }
  return out
}
