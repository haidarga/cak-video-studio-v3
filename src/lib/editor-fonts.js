// Shared font catalog — single source of truth for both the editor UI
// (TextPanel dropdown + preview style) and the canvas render path
// (editor-render.js MediaRecorder fallback). ffmpeg.wasm export still uses
// system-ui because we'd need to bundle .ttf files into the wasm fs to do
// otherwise; the canvas fallback DOES honor these because the editor page
// injects the Google Fonts <link> at mount.

export const FONT_OPTIONS = [
  { id: 'inter', label: 'Inter (default)', css: 'Inter, system-ui, sans-serif', google: 'Inter:wght@400;600;700;900' },
  { id: 'poppins', label: 'Poppins', css: '"Poppins", system-ui, sans-serif', google: 'Poppins:wght@400;600;700;900' },
  { id: 'montserrat', label: 'Montserrat', css: '"Montserrat", system-ui, sans-serif', google: 'Montserrat:wght@400;600;700;900' },
  { id: 'bebas', label: 'Bebas Neue (impact)', css: '"Bebas Neue", Impact, sans-serif', google: 'Bebas+Neue' },
  { id: 'oswald', label: 'Oswald (condensed)', css: '"Oswald", Impact, sans-serif', google: 'Oswald:wght@400;600;700' },
  { id: 'anton', label: 'Anton (tall bold)', css: '"Anton", Impact, sans-serif', google: 'Anton' },
  { id: 'archivo-black', label: 'Archivo Black', css: '"Archivo Black", Impact, sans-serif', google: 'Archivo+Black' },
  { id: 'rubik-mono', label: 'Rubik Mono One', css: '"Rubik Mono One", monospace', google: 'Rubik+Mono+One' },
  { id: 'fjalla', label: 'Fjalla One', css: '"Fjalla One", Impact, sans-serif', google: 'Fjalla+One' },
  { id: 'lobster', label: 'Lobster (script)', css: '"Lobster", cursive', google: 'Lobster' },
  { id: 'pacifico', label: 'Pacifico (handwritten)', css: '"Pacifico", cursive', google: 'Pacifico' },
  { id: 'permanent-marker', label: 'Permanent Marker', css: '"Permanent Marker", cursive', google: 'Permanent+Marker' },
  { id: 'bangers', label: 'Bangers (comic)', css: '"Bangers", Impact, sans-serif', google: 'Bangers' },
  { id: 'comfortaa', label: 'Comfortaa (rounded)', css: '"Comfortaa", system-ui, sans-serif', google: 'Comfortaa:wght@400;600;700' },
  { id: 'roboto-mono', label: 'Roboto Mono', css: '"Roboto Mono", monospace', google: 'Roboto+Mono:wght@400;600;700' },
]

export const DEFAULT_FONT = 'inter'

export function getFontCss(id) {
  return (FONT_OPTIONS.find((f) => f.id === id) || FONT_OPTIONS[0]).css
}
