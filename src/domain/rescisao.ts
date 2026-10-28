/**
 * Rescisão de contrato CLT no Brasil: quanto entra no termo de rescisão (TRCT) e quanto do FGTS
 * pode ser sacado. Estimativa com as regras gerais da CLT; convenção coletiva, horas extras e
 * outras verbas do contrato ficam de fora. Datas em ISO (yyyy-mm-dd), valores em BRL.
 */

export type TipoRescisao = 'sem_justa_causa' | 'acordo' | 'pedido' | 'justa_causa'
export type Aviso = 'indenizado' | 'trabalhado' | 'nao_cumprido' | 'dispensado'

export interface RescisaoInput {
  kind: 'rescisao' // marks the row in the scenarios table
  name: string
  admissao: string
  desligamento: string // último dia trabalhado
  tipo: TipoRescisao
  aviso: Aviso
  salario: number // salário mensal bruto
  adicionais: number // médias mensais que integram a remuneração (adicionais, comissões, horas extras habituais)
  feriasVencidas: number // períodos aquisitivos completos ainda não gozados
  adiantamento13: number // primeira parcela do 13º já paga no ano
  saldoFgts: number // saldo da conta do FGTS deste contrato
  dependentes: number
  outrosDescontos: number
}

export const TIPOS: Record<TipoRescisao, { label: string; avisos: Aviso[] }> = {
  sem_justa_causa: { label: 'Dispensa sem justa causa', avisos: ['indenizado', 'trabalhado'] },
  acordo: { label: 'Acordo (art. 484-A)', avisos: ['indenizado', 'trabalhado'] },
  pedido: { label: 'Pedido de demissão', avisos: ['trabalhado', 'nao_cumprido', 'dispensado'] },
  justa_causa: { label: 'Justa causa', avisos: [] },
}
export const AVISOS: Record<Aviso, string> = {
  indenizado: 'Indenizado (pago sem trabalhar)',
  trabalhado: 'Trabalhado',
  nao_cumprido: 'Não cumprido (descontado)',
  dispensado: 'Dispensado pela empresa',
}

/** Tabelas de 2026 — conferir a cada ano. INSS: faixas progressivas até o teto. */
export const INSS_2026: [number, number][] = [[1621.0, 0.075], [2902.84, 0.09], [4354.27, 0.12], [8475.55, 0.14]]
/** IRRF mensal: [limite da faixa, alíquota, parcela a deduzir]. */
export const IRRF_2026: [number, number, number][] = [
  [2428.8, 0, 0], [2826.65, 0.075, 182.16], [3751.05, 0.15, 394.16], [4664.68, 0.225, 675.49], [Infinity, 0.275, 908.73],
]
export const DEDUCAO_DEPENDENTE = 189.59
export const DESCONTO_SIMPLIFICADO = 607.2

export function inss(base: number): number {
  let total = 0, prev = 0
  for (const [lim, rate] of INSS_2026) {
    if (base <= prev) break
    total += (Math.min(base, lim) - prev) * rate
    prev = lim
  }
  return round(total)
}

/**
 * IRRF pela tabela mensal, com a redução da Lei 15.270/2025: zera o imposto até R$ 5.000 de
 * rendimento tributável e reduz parcialmente até R$ 7.350.
 */
export function irrf(rendimento: number, deducoes: number): number {
  const base = Math.max(0, rendimento - deducoes)
  const [, rate, ded] = IRRF_2026.find(([lim]) => base <= lim)!
  const bruto = Math.max(0, base * rate - ded)
  const reducao = rendimento <= 5000 ? bruto : rendimento <= 7350 ? Math.max(0, 978.62 - 0.133145 * rendimento) : 0
  return round(Math.max(0, bruto - reducao))
}

const round = (n: number) => Math.round(n * 100 + 1e-6) / 100 // 121,575 → 121,58 despite binary floats
const toDate = (iso: string) => new Date(`${iso}T00:00:00Z`)
const iso = (d: Date) => d.toISOString().slice(0, 10)
const DAY = 86400000
export const addDays = (s: string, n: number) => iso(new Date(toDate(s).getTime() + n * DAY))
const addMonths = (s: string, n: number) => {
  const d = toDate(s)
  const day = d.getUTCDate()
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1))
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate()
  return iso(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(day, last))))
}
const daysBetween = (a: string, b: string) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / DAY)

/** Anos completos de serviço entre a admissão e o fim. */
export function anosCompletos(admissao: string, fim: string): number {
  let n = 0
  while (addMonths(admissao, 12 * (n + 1)) <= addDays(fim, 1)) n++
  return n
}

/** Avos do 13º: meses do ano do fim com pelo menos 15 dias trabalhados. */
export function avos13(admissao: string, fim: string): number {
  const year = fim.slice(0, 4)
  let n = 0
  for (let m = 1; m <= Number(fim.slice(5, 7)); m++) {
    const first = `${year}-${String(m).padStart(2, '0')}-01`
    const last = addDays(addMonths(first, 1), -1)
    const from = admissao > first ? admissao : first
    const to = fim < last ? fim : last
    if (from <= to && daysBetween(from, to) + 1 >= 15) n++
  }
  return n
}

/** Avos de férias proporcionais: meses desde o último aniversário da admissão (fração ≥ 15 dias conta). */
export function avosFerias(admissao: string, fim: string): number {
  const start = addMonths(admissao, 12 * anosCompletos(admissao, fim))
  const after = addDays(fim, 1)
  let n = 0
  while (n < 12 && addMonths(start, n + 1) <= after) n++
  if (n < 12 && daysBetween(addMonths(start, n), after) >= 15) n++
  return n
}

/** Dias de aviso prévio da Lei 12.506/2011: 30 + 3 por ano completo, até 90. */
export const diasAviso = (admissao: string, fim: string) => 30 + 3 * Math.min(20, anosCompletos(admissao, fim))

export interface Verba { label: string; valor: number; nota?: string }
export interface RescisaoResult {
  verbas: Verba[] // proventos
  descontos: Verba[]
  bruto: number
  totalDescontos: number
  liquido: number // o que o TRCT paga
  fimProjetado: string // fim do contrato com a projeção do aviso indenizado
  diasAvisoPagos: number
  avos13: number
  avosFerias: number
  fgts: { saldo: number; deposito: number; multa: number; multaPct: number; sacavel: number; ficaNaConta: number }
  total: number // líquido + FGTS sacável
}

export function calcularRescisao(i: RescisaoInput): RescisaoResult {
  const rem = i.salario + i.adicionais
  const dia = rem / 30
  const justa = i.tipo === 'justa_causa'
  const aviso = justa ? null : TIPOS[i.tipo].avisos.includes(i.aviso) ? i.aviso : TIPOS[i.tipo].avisos[0]

  // Aviso indenizado: pago e projetado no tempo de serviço (conta para 13º e férias).
  const diasLei = diasAviso(i.admissao, i.desligamento)
  const diasAvisoPagos = aviso === 'indenizado' ? (i.tipo === 'acordo' ? Math.floor(diasLei / 2) : diasLei) : 0
  const fimProjetado = addDays(i.desligamento, diasAvisoPagos)

  const saldoSalario = round(dia * Math.min(30, Number(i.desligamento.slice(8, 10))))
  const avisoValor = round(dia * diasAvisoPagos)
  const a13 = justa ? 0 : avos13(i.admissao, fimProjetado)
  const decimo = round((rem * a13) / 12)
  const aFer = justa ? 0 : avosFerias(i.admissao, fimProjetado)
  const venc = round(rem * i.feriasVencidas)
  const prop = round((rem * aFer) / 12)

  const verbas: Verba[] = [
    { label: `Saldo de salário (${Math.min(30, Number(i.desligamento.slice(8, 10)))} dias)`, valor: saldoSalario },
    { label: `Aviso prévio indenizado (${diasAvisoPagos} dias)`, valor: avisoValor, nota: 'sem INSS e sem IR' },
    { label: `13º proporcional (${a13}/12)`, valor: decimo },
    { label: `Férias vencidas (${i.feriasVencidas} período(s))`, valor: venc, nota: 'sem INSS e sem IR' },
    { label: '1/3 das férias vencidas', valor: round(venc / 3), nota: 'sem INSS e sem IR' },
    { label: `Férias proporcionais (${aFer}/12)`, valor: prop, nota: 'sem INSS e sem IR' },
    { label: '1/3 das férias proporcionais', valor: round(prop / 3), nota: 'sem INSS e sem IR' },
  ].filter((v) => v.valor > 0)

  // Saldo de salário pela tabela mensal; 13º em separado (tributação exclusiva). Férias e aviso indenizados são isentos.
  const inssSaldo = inss(saldoSalario)
  const inss13 = inss(decimo)
  const deps = i.dependentes * DEDUCAO_DEPENDENTE
  const irSaldo = irrf(saldoSalario, Math.max(inssSaldo + deps, DESCONTO_SIMPLIFICADO))
  const ir13 = irrf(decimo, inss13 + deps)
  const descontos: Verba[] = [
    { label: 'INSS sobre o saldo de salário', valor: inssSaldo },
    { label: 'INSS sobre o 13º', valor: inss13 },
    { label: 'IR sobre o saldo de salário', valor: irSaldo },
    { label: 'IR sobre o 13º', valor: ir13 },
    { label: 'Adiantamento do 13º já pago', valor: Math.min(i.adiantamento13, decimo) },
    { label: 'Aviso prévio não cumprido', valor: aviso === 'nao_cumprido' ? round(rem) : 0 },
    { label: 'Outros descontos', valor: i.outrosDescontos },
  ].filter((v) => v.valor > 0)

  const bruto = round(verbas.reduce((s, v) => s + v.valor, 0))
  const totalDescontos = round(descontos.reduce((s, v) => s + v.valor, 0))
  const liquido = round(Math.max(0, bruto - totalDescontos))

  // FGTS: 8% sobre saldo, aviso e 13º vai para a conta; a multa incide sobre o saldo com esse depósito.
  const deposito = round(0.08 * (saldoSalario + avisoValor + decimo))
  const multaPct = i.tipo === 'sem_justa_causa' ? 0.4 : i.tipo === 'acordo' ? 0.2 : 0
  const conta = i.saldoFgts + deposito
  const multa = round(conta * multaPct)
  const saquePct = i.tipo === 'sem_justa_causa' ? 1 : i.tipo === 'acordo' ? 0.8 : 0
  const sacavel = round(conta * saquePct + multa)
  return {
    verbas, descontos, bruto, totalDescontos, liquido, fimProjetado, diasAvisoPagos, avos13: a13, avosFerias: aFer,
    fgts: { saldo: i.saldoFgts, deposito, multa, multaPct, sacavel, ficaNaConta: round(conta * (1 - saquePct)) },
    total: round(liquido + sacavel),
  }
}

export const novaRescisao = (salario = 0): RescisaoInput => ({
  kind: 'rescisao', name: 'Nova simulação', admissao: '', desligamento: new Date().toISOString().slice(0, 10),
  tipo: 'sem_justa_causa', aviso: 'indenizado', salario, adicionais: 0, feriasVencidas: 0, adiantamento13: 0,
  saldoFgts: 0, dependentes: 0, outrosDescontos: 0,
})

export const isRescisao = (d: unknown): d is RescisaoInput => (d as { kind?: string } | null)?.kind === 'rescisao'
