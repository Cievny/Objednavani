import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
// písmo (v104): Source Sans 3 pre text a rozhranie, Source Serif 4 len pre hlavné nadpisy;
// latin-ext = slovenská diakritika; self-hosted (žiadne externé CDN, CSP ostáva prísne)
import '@fontsource/source-sans-3/latin-400.css'
import '@fontsource/source-sans-3/latin-ext-400.css'
import '@fontsource/source-sans-3/latin-500.css'
import '@fontsource/source-sans-3/latin-ext-500.css'
import '@fontsource/source-sans-3/latin-600.css'
import '@fontsource/source-sans-3/latin-ext-600.css'
import '@fontsource/source-sans-3/latin-700.css'
import '@fontsource/source-sans-3/latin-ext-700.css'
import '@fontsource/source-serif-4/latin-600.css'
import '@fontsource/source-serif-4/latin-ext-600.css'
import '@fontsource/source-serif-4/latin-700.css'
import '@fontsource/source-serif-4/latin-ext-700.css'
import './index.css'

// PWA manifest podľa režimu nasadenia: správa (/sprava/) má vlastný názov
// a ikonu na ploche; relatívna cesta platí pre obe umiestnenia.
const appMode = import.meta.env.VITE_APP_MODE || 'combined'
const manifestLink = document.createElement('link')
manifestLink.rel = 'manifest'
manifestLink.href = appMode === 'admin' ? 'manifest-sprava.webmanifest' : 'manifest.webmanifest'
document.head.appendChild(manifestLink)
if (appMode === 'admin') document.title = 'USG Správa | NÚSCH, a.s.'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
