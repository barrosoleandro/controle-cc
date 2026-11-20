/**
 * Pedido de acesso aprovado pelo celular do dono da casa (QR code): o que o app sabe do pedido sem
 * falar com o servidor. A mesma regra do código de pareamento está em
 * supabase/functions/household-access (publicada sozinha, sem acesso a src/); tests/access.test.ts
 * confere as duas.
 */
export const PAIR_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ' // sem 0/O, 1/I/L
export const PAIR_LENGTH = 8
export const APPROVE_PARAM = 'aprovar'

/** "k7m2-q9xd", a URL do QR com ?aprovar=…, espaços: só os 8 caracteres válidos, ou null. */
export function normalizePairCode(raw: string): string | null {
  const m = raw.match(/[?&]aprovar=([^&#]+)/)
  const code = (m ? decodeURIComponent(m[1]) : raw).toUpperCase().replace(/[\s-]/g, '')
  if (code.length !== PAIR_LENGTH) return null
  return [...code].every((c) => PAIR_ALPHABET.includes(c)) ? code : null
}

/** "K7M2Q9XD" → "K7M2-Q9XD", para ler e digitar. */
export const formatPairCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`

/** O que o QR carrega: o próprio app, que abre a tela de aprovação. */
export const approveUrl = (origin: string, code: string) => `${origin}/?${APPROVE_PARAM}=${code}`

/** O que a aprovação vai fazer, dito ao dono antes de aprovar. */
export const PLAN_TEXT: Record<string, string> = {
  create: 'Conta nova: ao aprovar, ela é criada e entra na sua casa (vê e edita todos os dados).',
  login: 'Já é da sua casa (ou é você): ao aprovar, este aparelho entra.',
  so_dono: 'Só o dono da casa aprova acessos.',
  conta_de_outra_casa: 'Este e-mail é de uma conta que não é da sua casa: não dá para aprovar daqui.',
}

/** Mensagens para os códigos de erro da Edge Function. */
export const ACCESS_ERRORS: Record<string, string> = {
  precisa_login: 'Entre no app neste aparelho para aprovar.',
  email_invalido: 'E-mail inválido.',
  codigo_invalido: 'Código inválido. Confira os 8 caracteres mostrados no outro aparelho.',
  pedido_expirado: 'O pedido expirou ou já foi usado. Peça de novo no outro aparelho.',
  numero_errado: 'Número errado: o pedido foi cancelado por segurança. Peça de novo no outro aparelho.',
  so_dono: PLAN_TEXT.so_dono,
  conta_de_outra_casa: PLAN_TEXT.conta_de_outra_casa,
  muitos_pedidos: 'Muitos pedidos seguidos. Espere alguns minutos.',
  criar_conta: 'Não foi possível criar a conta. Tente de novo.',
  incluir_na_casa: 'Não foi possível incluir na casa: rode a migração 011 no Supabase.',
  membro: 'Essa pessoa não é da sua casa.',
  jwt_ligado: 'A função "household-access" está com "Enforce JWT verification" ligado no Supabase: desligue.',
  nao_publicada: 'O acesso pelo celular ainda não está ativo: falta publicar a função "household-access" no Supabase.',
}
export const accessError = (code: string) => ACCESS_ERRORS[code] ?? `Não foi possível concluir (${code}).`

/** Sistema e navegador, mostrados no celular para você reconhecer o aparelho que pediu. */
export function describeAgent(ua: string): { os: string; browser: string } {
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'desconhecido'
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'navegador'
  return { os, browser }
}
