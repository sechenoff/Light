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
          DEFAULT: "#09090b",
          2: "#52525b",
          3: "#a1a1aa",
        },
        surface: {
          DEFAULT: "#ffffff",
          muted: "#fafafa",
          subtle: "#f4f4f5",
        },
        border: {
          DEFAULT: "#e4e4e7",
          strong: "#d4d4d8",
        },
        accent: {
          DEFAULT: "#1e3a8a",
          bright: "#1d4ed8",
          soft: "#eff6ff",
          border: "#bfdbfe",
        },
        teal: {
          DEFAULT: "#0f766e",
          soft: "#ccfbf1",
          border: "#99f6e4",
        },
        amber: {
          DEFAULT: "#a16207",
          soft: "#fef3c7",
          border: "#fde68a",
        },
        rose: {
          DEFAULT: "#9f1239",
          soft: "#ffe4e6",
          border: "#fecdd3",
        },
        indigo: {
          DEFAULT: "#4338ca",
          soft: "#e0e7ff",
          border: "#c7d2fe",
        },
        slate: {
          DEFAULT: "#334155",
          soft: "#f1f5f9",
          border: "#cbd5e1",
        },
        emerald: {
          DEFAULT: "#047857",
          soft: "#d1fae5",
          border: "#a7f3d0",
        },
        ok: {
          DEFAULT: "#15803d",
          soft: "#dcfce7",
        },
        warn: {
          DEFAULT: "#a16207",
          soft: "#fef9c3",
        },
        // Gaffer design-system tokens — scoped to .gaffer-root
        gaffer: {
          bg:            "var(--gaffer-bg)",
          "bg-sub":      "var(--gaffer-bg-sub)",
          "bg-hover":    "var(--gaffer-bg-hover)",
          "bg-panel":    "var(--gaffer-bg-panel)",
          border:        "var(--gaffer-border)",
          "border-strong": "var(--gaffer-border-strong)",
          divider:       "var(--gaffer-divider)",
          fg:            "var(--gaffer-fg)",
          "fg-muted":    "var(--gaffer-fg-muted)",
          "fg-subtle":   "var(--gaffer-fg-subtle)",
          accent:        "var(--gaffer-accent)",
          "accent-soft": "var(--gaffer-accent-soft)",
          "accent-fg":   "var(--gaffer-accent-fg)",
          pos:           "var(--gaffer-pos)",
          "pos-soft":    "var(--gaffer-pos-soft)",
          neg:           "var(--gaffer-neg)",
          "neg-soft":    "var(--gaffer-neg-soft)",
          warn:          "var(--gaffer-warn)",
          "warn-soft":   "var(--gaffer-warn-soft)",
          info:          "var(--gaffer-info)",
          "info-soft":   "var(--gaffer-info-soft)",
        },
      },
      screens: {
        "gaffer-md": { max: "780px" },
        "gaffer-sm": { max: "430px" },
      },
      borderRadius: {
        DEFAULT: "4px",
        lg: "6px",
      },
      boxShadow: {
        xs: "0 1px 0 rgba(9,9,11,.03)",
        sm: "0 1px 2px rgba(9,9,11,.05), 0 0 0 1px rgba(9,9,11,.02)",
      },
    },
  },
  plugins: [],
};
