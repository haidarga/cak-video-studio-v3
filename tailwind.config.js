/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        accent: '#ff3c3c',
        surface: '#0f0f0f',
        surface2: '#1a1a1a',
      },
    },
  },
  plugins: [],
}
