import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Beta build (VITE_BETA=1): staticky vloží robots noindex do index.html,
// aby betu neindexovali ani crawlery, ktoré nespúšťajú JavaScript.
const betaNoindex = () => ({
  name: 'beta-noindex',
  transformIndexHtml(html) {
    if (process.env.VITE_BETA !== '1') return html
    return html.replace('</head>', '  <meta name="robots" content="noindex" />\n  </head>')
  },
})

// Audit vlna 8: CSP connect-src len na KONKRÉTNY projektový host Supabase
// (z VITE_SUPABASE_URL), nie na *.supabase.co; demo build bez Supabase má
// len 'self'. Zároveň zakáže vkladanie do rámov a odosielanie formulárov inam.
const cspPin = () => ({
  name: 'csp-pin',
  transformIndexHtml(html) {
    const url = process.env.VITE_SUPABASE_URL || ''
    let host = ''
    try { host = url ? new URL(url).host : '' } catch { host = '' }
    const connect = host ? `'self' https://${host} wss://${host}` : `'self'`
    return html
      .replace("connect-src 'self' https://*.supabase.co wss://*.supabase.co", `connect-src ${connect}`)
      .replace("base-uri 'self'", "base-uri 'self'; frame-src 'none'; form-action 'self'")
  },
})

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), betaNoindex(), cspPin()],
})
