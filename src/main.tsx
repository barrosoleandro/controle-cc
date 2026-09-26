import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'

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
