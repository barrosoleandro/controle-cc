import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { execSync } from 'node:child_process'

/**
 * Which version is running, stamped at build time (shown on the Painel). Vercel passes the
 * commit in env vars; a local build asks git. The PWA updates itself in the background, so
 * this is how to tell whether the latest deploy has reached this device.
 */
const git = (args: string) => { try { return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch { return '' } }
const VERSION = {
  commit: (process.env.VERCEL_GIT_COMMIT_SHA || git('rev-parse HEAD')).slice(0, 7),
  message: (process.env.VERCEL_GIT_COMMIT_MESSAGE || git('log -1 --format=%s')).split('\n')[0],
  builtAt: new Date().toISOString(),
}

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(VERSION) },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Finanças Pessoais', short_name: 'Finanças', start_url: '/', display: 'standalone',
        lang: 'pt-BR', description: 'Controle das contas de casa: extratos, recorrentes, holerites, simulações e investimentos.',
        background_color: '#f5f7fb', theme_color: '#4f46e5',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
      },
      // Cache only the app shell; financial data is never cached by the service worker.
      workbox: { globPatterns: ['**/*.{js,css,html,svg,mjs}'], maximumFileSizeToCacheInBytes: 5 * 1024 * 1024, navigateFallbackDenylist: [/^\/auth/] },
    }),
  ],
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
})
