/** Replaced at build time by vite.config.ts. */
declare const __APP_VERSION__: { commit: string; message: string; builtAt: string }

export const VERSION = __APP_VERSION__

/** "versão 9dbf676 · publicada em 10/10/2026 18:12" */
export function versionLabel(v = VERSION): string {
  const when = new Date(v.builtAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
  return `versão ${v.commit || 'local'} · publicada em ${when}`
}
