/** @type {import('tailwindcss').Config} */
// Токены заданы как rgb(var(--c-*) / <alpha-value>): значения переменных живут
// в globals.css (:root = светлая тема, [data-theme="dark"] = ночная). Channel-
// формат (без запятых) сохраняет работу opacity-модификаторов Tailwind
// (bg-emerald-soft/30 и т.п.). Ночной режим = смена значений переменных, а не
// перекраска компонентов. См. src/lib/theme.ts + ThemeToggle.
const t = (name) => `rgb(var(${name}) / <alpha-value>)`;

module.exports = {
  content: ["./app/**/*.{js,ts,tsx}", "./src/**/*.{js,ts,tsx}"],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      fontFamily: {
        sans: ["IBM Plex Sans", "system-ui", "sans-serif"],
        cond: ["IBM Plex Sans Condensed", "system-ui", "sans-serif"],
        // "IBM Plex Sans" before generic monospace: IBM Plex Mono lacks the
        // ₽ glyph (U+20BD); without this the browser falls back to an
        // arbitrary system mono only for ₽ (different weight/colour than the
        // digits). Sans fallback keeps ₽ visually consistent with the digits.
        mono: ["IBM Plex Mono", "IBM Plex Sans", "ui-monospace", "monospace"],
      },
      colors: {
        ink: {
          DEFAULT: t("--c-ink"),
          2: t("--c-ink-2"),
          3: t("--c-ink-3"),
        },
        surface: {
          DEFAULT: t("--c-surface"),
          muted: t("--c-surface-muted"),
          subtle: t("--c-surface-subtle"),
        },
        border: {
          DEFAULT: t("--c-border"),
          strong: t("--c-border-strong"),
        },
        accent: {
          DEFAULT: t("--c-accent"),
          bright: t("--c-accent-bright"),
          soft: t("--c-accent-soft"),
          border: t("--c-accent-border"),
        },
        teal: {
          DEFAULT: t("--c-teal"),
          soft: t("--c-teal-soft"),
          border: t("--c-teal-border"),
        },
        amber: {
          DEFAULT: t("--c-amber"),
          soft: t("--c-amber-soft"),
          border: t("--c-amber-border"),
        },
        rose: {
          DEFAULT: t("--c-rose"),
          soft: t("--c-rose-soft"),
          border: t("--c-rose-border"),
        },
        indigo: {
          DEFAULT: t("--c-indigo"),
          soft: t("--c-indigo-soft"),
          border: t("--c-indigo-border"),
        },
        slate: {
          DEFAULT: t("--c-slate"),
          soft: t("--c-slate-soft"),
          border: t("--c-slate-border"),
        },
        emerald: {
          DEFAULT: t("--c-emerald"),
          soft: t("--c-emerald-soft"),
          border: t("--c-emerald-border"),
        },
        ok: {
          DEFAULT: t("--c-ok"),
          soft: t("--c-ok-soft"),
          border: t("--c-ok-border"),
        },
        warn: {
          DEFAULT: t("--c-warn"),
          soft: t("--c-warn-soft"),
        },
        // Тёмная хромировка и подложка модалок — НЕ инвертируются вместе с ink.
        inverse: t("--c-inverse"),
        "accent-chrome": t("--c-accent-chrome"),
        "on-inverse": t("--c-on-inverse"),
        scrim: t("--c-scrim"),
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
      keyframes: {
        slidein: {
          from: { transform: "translateX(24px)", opacity: "0.6" },
          to: { transform: "translateX(0)", opacity: "1" },
        },
        // Vertical companion to `slidein` for bottom sheets (must rise UP,
        // not slide sideways). Same curve/feel as `slidein`: a short
        // translate + slight opacity fade, compositor-friendly only.
        slideup: {
          from: { transform: "translateY(16px)", opacity: "0.6" },
          to: { transform: "translateY(0)", opacity: "1" },
        },
      },
      animation: {
        slidein: "slidein 180ms ease-out",
        slideup: "slideup 180ms ease-out",
      },
    },
  },
  plugins: [],
};
