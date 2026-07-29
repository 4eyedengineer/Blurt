import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { SettingsProvider } from './context/SettingsContext'
import { OverlayApp } from './overlay/OverlayApp'

// The push-to-talk overlay window (src/main/overlay.ts) loads this exact
// same renderer bundle with a `#overlay` hash so it doesn't need a second
// entry point/build target - route on that instead.
const isOverlay = window.location.hash === '#overlay'
if (isOverlay) {
  document.documentElement.classList.add('overlay-shell')
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isOverlay ? (
      <OverlayApp />
    ) : (
      <SettingsProvider>
        <App />
      </SettingsProvider>
    )}
  </StrictMode>
)
