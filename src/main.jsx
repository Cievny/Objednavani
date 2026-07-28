import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import '@fontsource/roboto/latin-400.css'
import '@fontsource/roboto/latin-ext-400.css'
import '@fontsource/roboto/latin-500.css'
import '@fontsource/roboto/latin-ext-500.css'
import '@fontsource/roboto/latin-700.css'
import '@fontsource/roboto/latin-ext-700.css'
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
