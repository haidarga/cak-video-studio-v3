/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        accent: '#b552ff',
        'accent-bright': '#d946ef',
        surface: '#160f26',
        surface2: '#1c1532',
        surface3: '#281e46',
        purple: '#a855f7',
        magenta: '#d946ef',
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'Inter', 'sans-serif'],
        sans: ['Inter', '"Space Grotesk"', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        glow: '0 0 28px rgba(217,70,239,0.4)',
        'glow-lg': '0 0 60px rgba(217,70,239,0.5)',
      },
    },
  },
  plugins: [],
}
