/**
 * Acesso pontual aprovado pelo celular (QR code): o que o app precisa saber do pedido sem falar
 * com o servidor. A mesma regra do código de pareamento está em supabase/functions/qr-login
 * (a Edge Function é publicada sozinha, sem acesso a src/); tests/qrLogin.test.ts confere as duas.
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

/** Mensagens para os códigos de erro da Edge Function. */
export const QR_ERRORS: Record<string, string> = {
  precisa_aal2: 'Este aparelho precisa estar logado com a verificação em duas etapas para aprovar.',
  codigo_invalido: 'Código inválido. Confira os 8 caracteres mostrados no outro aparelho.',
  pedido_expirado: 'O pedido expirou ou já foi usado. Gere um QR code novo no outro aparelho.',
  numero_errado: 'Número errado: o pedido foi cancelado por segurança. Gere um QR code novo no outro aparelho.',
  confirme_biometria: 'Confirme com a biometria ou o código do autenticador antes de aprovar.',
  muitos_pedidos: 'Muitos pedidos seguidos. Espere alguns minutos.',
  jwt_ligado: 'A função "qr-login" está com "Enforce JWT verification" ligado no Supabase: desligue para o login por QR code funcionar.',
  nao_publicada: 'O login por QR code ainda não está ativo: falta publicar a função "qr-login" no Supabase.',
}
export const qrError = (code: string) => QR_ERRORS[code] ?? `Não foi possível concluir (${code}).`

/** Sistema e navegador, mostrados no celular para você reconhecer o aparelho que pediu. */
export function describeAgent(ua: string): { os: string; browser: string } {
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'desconhecido'
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'navegador'
  return { os, browser }
}
