import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { StyleGuide } from './StyleGuide.tsx'

// The style guide is a dev surface, not a route the app links to — hash check
// rather than a router dependency. Visit #/styleguide to open it.
const isStyleGuide = window.location.hash === '#/styleguide'

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isStyleGuide ? <StyleGuide /> : <App />}</StrictMode>,
)
