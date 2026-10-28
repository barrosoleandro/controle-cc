import type { IconName } from '../components/Icons'

/**
 * Every page, grouped the way the side menu shows them, with the one line that says what the
 * page is for (shown under its title) and the sections inside it that the search can open.
 */
export const PAGES = {
  Painel: { icon: 'painel', desc: 'O mês num relance: saldos, receitas, despesas e orçamento.' },
  Análises: { icon: 'analises', desc: 'Gastos e receitas por período, categoria, estabelecimento e data.' },
  Lançamentos: { icon: 'lancamentos', desc: 'Tudo o que entrou e saiu das contas, mês a mês ou em lista.' },
  Cartões: { icon: 'cartoes', desc: 'Faturas do cartão, detalhe de cada uma e parcelas que ainda vêm.' },
  Recorrentes: { icon: 'recorrentes', desc: 'Assinaturas e cobranças que se repetem todo mês ou todo ano.' },
  Simulação: { icon: 'simulacao', desc: 'Cenários de salário e gastos a partir da sua base real.' },
  Rescisão: { icon: 'rescisao', desc: 'Quanto você recebe ao sair de um emprego CLT no Brasil.' },
  Investimentos: { icon: 'investimentos', desc: 'Quanto dá para investir por mês e como dividir.' },
  Mercado: { icon: 'mercado', desc: 'Sua remuneração comparada com o mercado.' },
  Holerites: { icon: 'holerites', desc: 'Holerites, conferência do contrato e evolução do salário.' },
  Importar: { icon: 'importar', desc: 'Extratos e faturas do banco em CSV, PDF ou Excel.' },
  Ajustes: { icon: 'ajustes', desc: 'Contas, orçamentos, categorias, regras e preferências.' },
} as const satisfies Record<string, { icon: IconName; desc: string }>

export type Tab = keyof typeof PAGES
export const TABS = Object.keys(PAGES) as Tab[]

export const GROUPS: { label: string; tabs: Tab[] }[] = [
  { label: 'Visão geral', tabs: ['Painel', 'Análises'] },
  { label: 'Dia a dia', tabs: ['Lançamentos', 'Cartões', 'Recorrentes'] },
  { label: 'Planejamento', tabs: ['Simulação', 'Rescisão', 'Investimentos', 'Mercado'] },
  { label: 'Dados', tabs: ['Importar', 'Holerites', 'Ajustes'] },
]

// On a phone the bottom bar holds these four; the rest open from "Mais".
export const PRIMARY: Tab[] = ['Painel', 'Lançamentos', 'Cartões', 'Importar']

/** Sections inside a page that the search opens directly (the page reads them as `sub`). */
export const SECTIONS: { tab: Tab; sub: string; label: string; keywords?: string }[] = [
  { tab: 'Análises', sub: 'geral', label: 'Visão geral' },
  { tab: 'Análises', sub: 'tendencia', label: 'Tendência', keywords: 'evolução histórico' },
  { tab: 'Análises', sub: 'categorias', label: 'Categorias' },
  { tab: 'Análises', sub: 'estab', label: 'Estabelecimentos', keywords: 'lojas comerciantes' },
  { tab: 'Análises', sub: 'datas', label: 'Datas', keywords: 'dia semana calendário' },
  { tab: 'Lançamentos', sub: 'Lista', label: 'Lista e busca', keywords: 'procurar exportar csv' },
  { tab: 'Lançamentos', sub: '12 meses', label: '12 meses', keywords: 'ano comparação' },
  { tab: 'Lançamentos', sub: 'Por país', label: 'Por país', keywords: 'brasil frança portugal' },
  { tab: 'Ajustes', sub: 'Contas', label: 'Contas', keywords: 'saldo inicial conciliação banco' },
  { tab: 'Ajustes', sub: 'Orçamentos', label: 'Orçamentos e salário', keywords: 'budget salário' },
  { tab: 'Ajustes', sub: 'Categorias', label: 'Categorias', keywords: 'mesclar simplificar' },
  { tab: 'Ajustes', sub: 'Regras', label: 'Regras', keywords: 'estabelecimento recategorizar' },
  { tab: 'Ajustes', sub: 'Mapa do banco', label: 'Mapa do banco' },
  { tab: 'Ajustes', sub: 'Cotações', label: 'Cotações EUR → BRL', keywords: 'câmbio real euro' },
  { tab: 'Ajustes', sub: 'IA local', label: 'IA local (Ollama)', keywords: 'inteligência artificial modelo' },
  { tab: 'Ajustes', sub: 'Aparência', label: 'Aparência', keywords: 'tema claro escuro modo' },
]

/** Accent- and case-insensitive text, for matching what is typed in the search. */
export const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
