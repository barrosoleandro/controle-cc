import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { registerSW } from 'virtual:pwa-register'

// The installed app serves its cached shell first, so a deploy used to show up only after
// two reloads. Check for a new build on start, when the app comes back to the front and
// every hour; with registerType 'autoUpdate' the page reloads itself once it is installed.
registerSW({
  immediate: true,
  onRegisteredSW(_url, reg) {
    if (!reg) return
    const check = () => { if (navigator.onLine) reg.update().catch(() => { /* offline or server down: try later */ }) }
    setInterval(check, 60 * 60 * 1000)
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check() })
  },
})

// After a deploy, a tab still running the old build asks for lazy chunks (pdf.js, xlsx)
// under hashes that no longer exist. Reload once to pick up the new build; the guard
// stops a reload loop if the chunk is genuinely broken.
window.addEventListener('vite:preloadError', (e) => {
  try {
    const last = Number(sessionStorage.getItem('chunkReload') ?? 0)
    if (Date.now() - last < 60_000) return
    sessionStorage.setItem('chunkReload', String(Date.now()))
  } catch { /* storage blocked: still try the reload */ }
  e.preventDefault()
  window.location.reload()
})

createRoot(document.getElementById('root')!).render(<StrictMode><ErrorBoundary><App /></ErrorBoundary></StrictMode>)
