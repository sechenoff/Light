/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,ts,tsx}", "./src/**/*.{js,ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["IBM Plex Sans", "system-ui", "sans-serif"],
        cond: ["IBM Plex Sans Condensed", "system-ui", "sans-serif"],
        mono: ["IBM Plex Mono", "ui-monospace", "monospace"],
      },
      colors: {
        ink: {
          DEFAULT: "#0f172a",
          2: "#334155",
          3: "#64748b",
        },
        surface: {
          DEFAULT: "#ffffff",
          2: "#f8fafc",
          3: "#f1f5f9",
        },
        border: {
          DEFAULT: "#e2e8f0",
          strong: "#cbd5e1",
        },
        accent: {
          DEFAULT: "#1e3a8a",
          bright: "#1d4ed8",
          soft: "#eff6ff",
          border: "#bfdbfe",
        },
        teal: {
          DEFAULT: "#0f766e",
          soft: "#f0fdfa",
          border: "#99f6e4",
        },
        amber: {
          DEFAULT: "#b45309",
          soft: "#fffbeb",
          border: "#fde68a",
        },
        rose: {
          DEFAULT: "#be123c",
          soft: "#fff1f2",
          border: "#fecdd3",
        },
        indigo: {
          DEFAULT: "#3730a3",
          soft: "#eef2ff",
          border: "#c7d2fe",
        },
        slate: {
          DEFAULT: "#475569",
          soft: "#f8fafc",
          border: "#e2e8f0",
          700: "#334155",
          800: "#1e293b",
          900: "#0f172a",
        },
        emerald: {
          DEFAULT: "#065f46",
          soft: "#ecfdf5",
          border: "#a7f3d0",
        },
        ok: "#16a34a",
        warn: "#d97706",
      },
      borderRadius: {
        sm: "4px",
        DEFAULT: "6px",
        md: "6px",
        lg: "8px",
        xl: "12px",
        "2xl": "16px",
      },
      boxShadow: {
        xs: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
        sm: "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
      },
    },
  },
  plugins: [],
};
