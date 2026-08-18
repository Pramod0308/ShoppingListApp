import forms from '@tailwindcss/forms';

/** @type {import('tailwindcss').Config} */
// Colours are CSS custom properties defined in web-src/styles.css, exposed to
// Tailwind as rgb(var(--token) / <alpha-value>) so opacity modifiers still work
// (bg-surface/70). Dark mode is one block of variable overrides rather than a
// dark: variant on every element, which is how half the old UI ended up light in
// dark mode: the header had a dark: rule and the page behind it did not.
export default {
  darkMode: 'class',
  content: ['./assets/www/index.html', './assets/www/app.js'],
  theme: {
    extend: {
      colors: {
        bg: 'rgb(var(--bg) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        raised: 'rgb(var(--raised) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        ink: 'rgb(var(--ink) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        faint: 'rgb(var(--faint) / <alpha-value>)',
        accent: 'rgb(var(--accent) / <alpha-value>)',
        'accent-ink': 'rgb(var(--accent-ink) / <alpha-value>)',
        'accent-soft': 'rgb(var(--accent-soft) / <alpha-value>)',
        danger: 'rgb(var(--danger) / <alpha-value>)',
        'danger-soft': 'rgb(var(--danger-soft) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['Geist', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        DEFAULT: '0.5rem',
        lg: '0.625rem',
        xl: '0.875rem',
        '2xl': '1.125rem',
      },
      boxShadow: {
        // One soft elevation, used sparingly. The old design put a shadow on every
        // card, which reads as clutter once the cards are dense.
        soft: '0 1px 2px rgb(0 0 0 / 0.04), 0 1px 3px rgb(0 0 0 / 0.06)',
        lift: '0 8px 24px rgb(0 0 0 / 0.12)',
      },
    },
  },
  // Normalises input rendering across browsers; the markup styles them from there.
  plugins: [forms],
};
