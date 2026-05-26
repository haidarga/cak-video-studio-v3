'use client'
import App from './App'
import { StudioProvider } from './store'
import './index.css'

// Wrapper that lives inside the v3 Next.js shell. v2's styles are scoped
// under `.studio-root` so they don't leak into v3's other pages.
export default function StudioApp() {
  return (
    <div className="studio-root">
      <StudioProvider>
        <App />
      </StudioProvider>
    </div>
  )
}
