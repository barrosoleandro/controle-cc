import type { BankMapEntry, CategoryKind, Rule } from './types'

/**
 * Default categories = the lines of Controle_CC_FR_New.xlsx (typos fixed: Engie, Picard,
 * Compras online; Adidas merged into Roupas) + a few additions (marked NEW) needed so that
 * transport, health, education and the Brazilian account do not all fall into "Outros".
 */
export const DEFAULT_CATEGORIES: { name: string; kind: CategoryKind; color: string; budget?: number }[] = [
  { name: 'Salario', kind: 'income', color: '#1b9e77' },
  { name: 'Reembolso', kind: 'income', color: '#66a61e' },
  { name: 'Rendimentos', kind: 'income', color: '#a6d854' }, // NEW – interest/yield
  { name: 'Outras receitas', kind: 'income', color: '#b3de69' }, // NEW
  { name: 'Transfer', kind: 'transfer', color: '#999999' },
  { name: 'Ajuste', kind: 'transfer', color: '#bbbbbb' },
  { name: 'Aluguel', kind: 'expense', color: '#d95f02', budget: 3550.75 },
  { name: 'Engie', kind: 'expense', color: '#e6ab02', budget: 800 },
  { name: 'Academia', kind: 'expense', color: '#7570b3', budget: 44 },
  { name: 'C3', kind: 'expense', color: '#e7298a', budget: 213.27 },
  { name: 'Dizimo', kind: 'expense', color: '#a6761d', budget: 1000 },
  { name: 'AXA - Seg. Carol', kind: 'expense', color: '#666666', budget: 158.67 },
  { name: 'Free', kind: 'expense', color: '#1f78b4', budget: 87.95 },
  { name: 'Business Trips', kind: 'expense', color: '#fb9a99', budget: 0 },
  { name: 'Compras online', kind: 'expense', color: '#fdbf6f', budget: 300 },
  { name: 'Mercado', kind: 'expense', color: '#33a02c', budget: 1300 },
  { name: 'Padaria', kind: 'expense', color: '#b15928', budget: 300 },
  { name: 'Picard', kind: 'expense', color: '#a6cee3', budget: 250 },
  { name: 'Restaurante', kind: 'expense', color: '#e31a1c', budget: 800 },
  { name: 'Streaming', kind: 'expense', color: '#6a3d9a', budget: 40 },
  { name: 'Preply', kind: 'expense', color: '#cab2d6', budget: 284.75 },
  { name: 'Conta', kind: 'expense', color: '#8c8c8c', budget: 28.1 },
  { name: 'Aquasport', kind: 'expense', color: '#17becf', budget: 300 },
  { name: 'Dry cleaning', kind: 'expense', color: '#bcbd22', budget: 100 },
  { name: 'Saques', kind: 'expense', color: '#7f7f7f', budget: 0 },
  { name: 'Roupas', kind: 'expense', color: '#ff7f0e', budget: 200 },
  { name: 'Assistencia', kind: 'expense', color: '#9467bd', budget: 300 },
  { name: 'Sodexo', kind: 'expense', color: '#8c564b', budget: 418 },
  { name: 'Viagem', kind: 'expense', color: '#2ca02c' },
  { name: 'Cultura', kind: 'expense', color: '#d62728' },
  { name: 'Instrumentos', kind: 'expense', color: '#9edae5' },
  { name: 'Transporte', kind: 'expense', color: '#393b79', budget: 300 }, // NEW
  { name: 'Saúde', kind: 'expense', color: '#637939' }, // NEW
  { name: 'Educação', kind: 'expense', color: '#8c6d31' }, // NEW
  { name: 'Lazer', kind: 'expense', color: '#843c39' }, // NEW
  { name: 'Impostos e taxas', kind: 'expense', color: '#7b4173' }, // NEW
  { name: 'Imóvel Brasil', kind: 'expense', color: '#3182bd' }, // NEW – condomínio, CEMIG, Claro, obra
  { name: 'Cartão Itaú', kind: 'expense', color: '#e6550d' }, // NEW – credit-card bill paid (detail not visible)
  { name: 'Outros', kind: 'expense', color: '#c7c7c7', budget: 200 },
]

/** Fallback when no merchant rule matches: bank's own category → personal category. */
export const DEFAULT_BANK_MAP: BankMapEntry[] = [
  ['Alimentation', 'Hyper/supermarche', 'Mercado'],
  ['Alimentation', 'Petit commercant', 'Mercado'],
  ['Alimentation', 'Alimentation - autre', 'Padaria'],
  ['Alimentation', 'Boulangerie', 'Padaria'],
  ['Alimentation', 'Restaurant', 'Restaurante'],
  ['Alimentation', 'Restauration rapide', 'Restaurante'],
  ['Alimentation', '*', 'Mercado'],
  ['Banque et assurances', 'Frais bancaires', 'Conta'],
  ['Banque et assurances', '*', 'Outros'],
  ['Education et famille', '*', 'Educação'],
  ['Juridique et administratif', '*', 'Impostos e taxas'],
  ['Impots et taxes', '*', 'Impostos e taxas'],
  ['Logement - maison', 'Loyer', 'Aluguel'],
  ['Logement - maison', 'Energie eau, gaz, electricite, fioul', 'Engie'],
  ['Logement - maison', 'Internet et telephonie', 'Free'],
  ['Logement - maison', '*', 'Outros'],
  ['Loisirs et vacances', 'Expo, musee, cinema', 'Cultura'],
  ['Loisirs et vacances', 'Livres, Magazines', 'Cultura'],
  ['Loisirs et vacances', 'Hotel', 'Viagem'],
  ['Loisirs et vacances', 'Video, Musique et jeux', 'Streaming'],
  ['Loisirs et vacances', '*', 'Lazer'],
  ["Revenus et rentrees d'argent", 'Remboursements de soins', 'Reembolso'],
  ["Revenus et rentrees d'argent", 'Salaires', 'Salario'],
  ["Revenus et rentrees d'argent", '*', 'Outras receitas'],
  ['Sante', '*', 'Saúde'],
  ['Shopping et services', 'Pressing', 'Dry cleaning'],
  ['Shopping et services', 'Vetements et chaussures', 'Roupas'],
  ['Shopping et services', '*', 'Outros'],
  ['Transaction exclue', '*', 'Transfer'],
  ['Transports', 'Trains, avions et ferrys', 'Viagem'],
  ['Transports', 'Location de voiture et moto', 'Viagem'],
  ['Transports', '*', 'Transporte'],
  ["A categoriser - sortie d'argent", "Retrait d'especes - a categoriser", 'Saques'],
  ["A categoriser - sortie d'argent", '*', 'Outros'],
  ["A categoriser - rentree d'argent", '*', 'Outras receitas'],
].map(([bank_category, bank_subcategory, category]) => ({ bank: 'BCP', bank_category, bank_subcategory, category }))

type R = [pattern: string, category: string, sign?: 'debit' | 'credit', bank?: string]
/** Merchant rules — evaluated before the bank map, first match wins (list order = priority). */
const RULES: R[] = [
  // Income
  ['VALLOUREC', 'Salario', 'credit'],
  ['MSH INTERNATIONAL', 'Reembolso', 'credit'],
  ['CPAM', 'Reembolso', 'credit'],
  ['REND PAGO APLIC', 'Rendimentos'],
  // Fixed costs France
  ['WHITE BIRD', 'Aluguel'],
  ['ENGIE', 'Engie'],
  ['JPO FORME', 'Academia'],
  ['CREDIPAR', 'C3'],
  ['MISSION EVANGELIQUE', 'Dizimo'],
  ['IGREJA', 'Dizimo'],
  ['AXA', 'AXA - Seg. Carol'],
  ['FREE MOBILE', 'Free'],
  ['FREEBOX', 'Free'],
  ['PREPLY', 'Preply'],
  ['SODEXO', 'Sodexo'],
  ['PRESSING', 'Dry cleaning'],
  // Subscriptions
  ['AMAZON PRIME', 'Streaming'],
  ['HBOMAX', 'Streaming'],
  ['NETFLIX', 'Streaming'],
  ['SPOTIFY', 'Streaming'],
  ['DISNEY', 'Streaming'],
  ['APPLE.COM', 'Streaming'],
  // Internal transfers (own accounts, Wise, savings)
  ['BARROSO OLIVEIRA', 'Transfer'],
  ['LEANDRO BARROSO', 'Transfer'],
  ['DE OLIVEIRA LEANDRO', 'Transfer'],
  ['PIX TRANSF LEANDRO', 'Transfer'],
  ['PIX QRS LEANDRO', 'Transfer'],
  ['WISE', 'Transfer'],
  ['OP REC EXT', 'Transfer'],
  ['REVOLUT', 'Transfer'],
  ['RESGATE CDB', 'Transfer'],
  ['BANCO XP', 'Transfer'],
  ['MILLENNIUM', 'Transfer'],
  ['OUVERTURE EPARGNE', 'Transfer'],
  ['OUV AUTO LIVRET', 'Transfer'],
  // Shopping / food
  ['AMAZON', 'Compras online'],
  ['AMZ ', 'Compras online'],
  ['ZALANDO', 'Compras online'],
  ['PICARD', 'Picard'],
  ['UBER EATS', 'Restaurante'],
  ['UBER *EATS', 'Restaurante'],
  ['IFOOD', 'Restaurante'],
  ['ADIDAS', 'Roupas'],
  ['DECATHLON', 'Lazer'],
  // Cash & fees
  ["RETRAIT D'ESPECES", 'Saques'],
  ['SAQUE', 'Saques'],
  ['FRAIS BANCAIRES', 'Conta'],
  ['COTISATION', 'Conta'],
  ['COM CB', 'Conta'],
  ['IOF', 'Conta'],
  ['SEGURO CARTAO', 'Conta'],
  // Brazil
  ['PERS INFINIT', 'Cartão Itaú'],
  ['PERSON INFI', 'Cartão Itaú'],
  ['PERS BLACK', 'Cartão Itaú'],
  ['FATURA PAGA', 'Cartão Itaú'],
  ['UNIMED', 'Saúde'],
  ['CONDOMINIO', 'Imóvel Brasil'],
  ['CEMIG', 'Imóvel Brasil'],
  ['CLARO', 'Imóvel Brasil'],
  ['CONSTRU', 'Imóvel Brasil'],
  ['VIDROSE', 'Imóvel Brasil'],
  ['GCLIMA', 'Imóvel Brasil'],
  ['JUSTICA ELE', 'Impostos e taxas'],
  ['ESTADO DE M', 'Impostos e taxas'],
  ['MUNICIPIO', 'Impostos e taxas'],
  ['POLICIA', 'Impostos e taxas'],
  ['OLIMPUS MOVEIS', 'Imóvel Brasil'],
  ['COLCHOA', 'Imóvel Brasil'],
  ['CREDITO CARTAO', 'Cartão Itaú'],
  ['ASSOC EDUCATION', 'Educação'],
  ['DECOLAR', 'Viagem'],
  ['LOCALIZ', 'Viagem'],
]

export const DEFAULT_RULES: Rule[] = RULES.map(([pattern, category, sign, bank], i) => ({
  pattern,
  category,
  sign: sign ?? null,
  bank: bank ?? null,
  priority: (i + 1) * 10,
}))

/** Items that need a human decision (shown in the mapping review file and in the app). */
export const MAPPING_OPEN_QUESTIONS = [
  'C3: assumed = CREDIPAR (car financing, ~213 €/month). Confirm.',
  'Aquasport, Assistencia: no matching merchant found in the BCP CSV — tell me the payee name.',
  'TEKEL (40 card payments, bank category "Shopping et services - autre") → currently Outros. Which category?',
  'Transfers to M/MLLE FARIA DE OLIVEIRA (family) → currently Outros. Allowance? Transfer?',
  'PIX to people in Brazil (CELIO, ARNOULD, CHRISTI, JANETE, Sara…) → currently Outros. Obra (Imóvel Brasil)?',
  'PAG BOLETO ITAU / PAG BOLETO BANCO → currently Outros (loan? insurance? consórcio?).',
  'Assumed Transfer (own money moving): RESGATE CDB, PAG BOLETO BANCO XP, VIREMENT VERS MILLENNIUM. Confirm.',
  'Cartão Itaú: only the bill total is visible — import the card statement to see real spending.',
]
