/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        ona: {
          bg: '#0a0a0a',
          surface: '#141414',
          panel: '#1a1a1a',
          border: '#2a2a2a',
          accent: '#f97316',
          accentHover: '#ea6c0a',
          fader: '#2d2d2d',
          active: '#22c55e',
          mute: '#ef4444',
          solo: '#eab308',
          text: '#e5e5e5',
          textMuted: '#737373'
        }
      }
    }
  },
  plugins: [],
}
