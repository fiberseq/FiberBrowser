/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // FiberBrowser brand scale, anchored on the app icon's tile
        // (#2a4fb5 -> #0a1330; hover/pressed #1e3a8a). Values live as RGB triplets in index.css so the
        // opacity modifiers (bg-brand-600/10) keep working.
        brand: {
          50: 'rgb(var(--fb-brand-50) / <alpha-value>)',
          100: 'rgb(var(--fb-brand-100) / <alpha-value>)',
          200: 'rgb(var(--fb-brand-200) / <alpha-value>)',
          300: 'rgb(var(--fb-brand-300) / <alpha-value>)',
          400: 'rgb(var(--fb-brand-400) / <alpha-value>)',
          500: 'rgb(var(--fb-brand-500) / <alpha-value>)',
          600: 'rgb(var(--fb-brand-600) / <alpha-value>)',
          700: 'rgb(var(--fb-brand-700) / <alpha-value>)',
          800: 'rgb(var(--fb-brand-800) / <alpha-value>)',
          900: 'rgb(var(--fb-brand-900) / <alpha-value>)',
          950: 'rgb(var(--fb-brand-950) / <alpha-value>)',
          // The single-molecule colours of the icon, for decorative accents only
          // (data tracks keep their own palettes in utils/layerColors.ts).
          nuc: '#33a040',
          tf: '#e040fb',
          acc: '#87ceeb',
        },
        // UI blue (buttons, links, selection) follows the brand instead of
        // Tailwind's default blue. Static hex, so dark: variants stay predictable.
        // Blue that encodes data is written as an explicit hex where it is used.
        blue: {
          50: '#f0f4fd',
          100: '#e0e8fb',
          200: '#c2d1f6',
          300: '#93acec',
          400: '#6286e0',
          500: '#3d63cc',
          600: '#2a4fb5',
          700: '#1e3a8a',
          800: '#1a3278',
          900: '#142658',
          950: '#0a1330',
        },
        // Theme-aware neutrals (light values in :root, dark ones under html.dark).
        surface: {
          DEFAULT: 'rgb(var(--fb-surface) / <alpha-value>)',
          raised: 'rgb(var(--fb-surface-raised) / <alpha-value>)',
          sunken: 'rgb(var(--fb-surface-sunken) / <alpha-value>)',
        },
        line: 'rgb(var(--fb-line) / <alpha-value>)',
        ink: {
          DEFAULT: 'rgb(var(--fb-ink) / <alpha-value>)',
          muted: 'rgb(var(--fb-ink-muted) / <alpha-value>)',
          faint: 'rgb(var(--fb-ink-faint) / <alpha-value>)',
          secondary: 'rgb(var(--fb-ink-secondary) / <alpha-value>)',
        },
        tool: {
          50: '#f5f6f9',
          100: '#e9ecf2',
          200: '#d5dae4',
          300: '#b3bac8',
          400: '#848c9c',
          500: '#6b7280',
          600: 'rgb(var(--fb-brand-600) / <alpha-value>)',
          700: 'rgb(var(--fb-brand-700) / <alpha-value>)',
          800: 'rgb(var(--fb-brand-800) / <alpha-value>)',
        },
        apple: {
          blue: 'rgb(var(--fb-brand-600) / <alpha-value>)',
          green: '#34C759',
          red: '#FF3B30',
          orange: '#FF9500',
          purple: '#AF52DE',
          gray: '#8E8E93',
          gray2: '#AEAEB2',
          gray3: '#C7C7CC',
          gray4: '#D1D1D6',
          gray5: '#E5E5EA',
          gray6: '#F2F2F7',
        },
        // Dark mode surfaces: navy-tinted, like the app icon, instead of neutral grey.
        dark: {
          bg: '#0f1524',
          surface: '#161e31',
          elevated: '#1e2940',
        },
      },
      boxShadow: {
        'toolbar': '0 0.5px 0 0 rgb(0 0 0 / 0.05), 0 2px 8px 0 rgb(0 0 0 / 0.04)',
        'toolbar-dark': '0 0.5px 0 0 rgb(255 255 255 / 0.05), 0 2px 8px 0 rgb(0 0 0 / 0.3)',
        'dropdown': '0 0 0 0.5px rgb(0 0 0 / 0.06), 0 4px 16px rgb(0 0 0 / 0.12), 0 12px 40px rgb(0 0 0 / 0.08)',
        'dropdown-dark': '0 0 0 0.5px rgb(255 255 255 / 0.08), 0 4px 16px rgb(0 0 0 / 0.4), 0 12px 40px rgb(0 0 0 / 0.3)',
        'btn': '0 0.5px 1px 0 rgb(0 0 0 / 0.04), 0 1px 3px 0 rgb(0 0 0 / 0.08)',
        'btn-dark': '0 0.5px 1px 0 rgb(0 0 0 / 0.2), 0 1px 3px 0 rgb(0 0 0 / 0.3)',
        'btn-active': 'inset 0 1px 3px 0 rgb(0 0 0 / 0.15)',
        'modal': '0 0 0 0.5px rgb(0 0 0 / 0.06), 0 8px 32px rgb(0 0 0 / 0.16), 0 24px 60px rgb(0 0 0 / 0.12)',
        'modal-dark': '0 0 0 0.5px rgb(255 255 255 / 0.08), 0 8px 32px rgb(0 0 0 / 0.5), 0 24px 60px rgb(0 0 0 / 0.4)',
        'panel': '0 1px 2px rgb(15 23 42 / 0.05), 0 0 0 1px rgb(15 23 42 / 0.04)',
        'chip': '0 1px 1px rgb(15 23 42 / 0.06)',
        'focus': '0 0 0 3px rgb(var(--fb-brand-500) / 0.28)',
      },
      fontSize: {
        'control': ['13px', { lineHeight: '1.25' }],
        // Type scale for dense panel UI: caption < label < body.
        'caption': ['10px', { lineHeight: '14px', letterSpacing: '0.01em' }],
        'label': ['11px', { lineHeight: '16px' }],
        'body': ['12px', { lineHeight: '18px' }],
      },
      borderRadius: {
        'apple': '10px',
        'apple-sm': '8px',
        'apple-lg': '14px',
        'fb': '6px',
        'fb-lg': '10px',
      },
    },
  },
  plugins: [],
}
