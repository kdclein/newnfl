/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#060610",       // near-black background
        panel: "#0c0c18",
        quality: "#5eead4",   // teal
        value: "#818cf8",     // indigo
        regime: "#f59e0b",    // amber
        pos: "#34d399",       // emerald
        neg: "#f87171",       // red
        neutral: "#fbbf24",   // yellow
      },
      fontFamily: {
        mono: ['"IBM Plex Mono"', "ui-monospace", "monospace"],
        sans: ['"DM Sans"', "ui-sans-serif", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
