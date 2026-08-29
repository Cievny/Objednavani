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

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), betaNoindex()],
})
