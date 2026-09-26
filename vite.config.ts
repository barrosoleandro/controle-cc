import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Finanças Pessoais', short_name: 'Finanças', start_url: '/', display: 'standalone',
        lang: 'pt-BR', description: 'Controle das contas de casa: extratos, recorrentes, holerites, simulações e investimentos.',
        background_color: '#111418', theme_color: '#2f6fde',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
      },
      // Cache only the app shell; financial data is never cached by the service worker.
      workbox: { globPatterns: ['**/*.{js,css,html,svg,mjs}'], maximumFileSizeToCacheInBytes: 5 * 1024 * 1024, navigateFallbackDenylist: [/^\/auth/] },
    }),
  ],
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
})
