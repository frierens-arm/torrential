import { THEME, PROVIDER_COLORS, type ThemeSpec } from './constants.js'

/**
 * Skins — hermes-agent-style themes. Each entry is a full ThemeSpec; the
 * active one is copied into the mutable THEME singleton in constants.ts so
 * every component re-renders with the new palette on the next React render.
 */
export interface ThemeEntry {
  id: string
  label: string
  description: string
  spec: ThemeSpec
}

export const THEMES: Record<string, ThemeEntry> = {
  rain: {
    id: 'rain',
    label: 'rain',
    description: 'violet → cyan downpour (default)',
    spec: {
      gradient: ['#f0abfc', '#c084fc', '#a78bfa', '#8b5cf6', '#60a5fa', '#38bdf8'],
      pink: '#f0abfc',
      violet: '#c084fc',
      indigo: '#818cf8',
      cyan: '#22d3ee',
      blue: '#60a5fa',
      green: '#4ade80',
      lime: '#a3e635',
      yellow: '#fbbf24',
      red: '#f87171',
      dim: 'gray',
      subtle: '#7c6f94',
      selBg: '#2e1a47',
      border: '#6d4fa8',
      barEmpty: '#4a4458',
      providerColors: { piratebay: '#22d3ee', '1337x': '#c084fc', nyaa: '#f0abfc' }
    }
  },
  matrix: {
    id: 'matrix',
    label: 'matrix',
    description: 'phosphor-green CRT',
    spec: {
      gradient: ['#e7ffdb', '#baffc4', '#86efac', '#4ade80', '#22c55e', '#15803d'],
      pink: '#bbf7d0',
      violet: '#86efac',
      indigo: '#4ade80',
      cyan: '#6ee7b7',
      blue: '#22c55e',
      green: '#4ade80',
      lime: '#a3e635',
      yellow: '#fde047',
      red: '#f87171',
      dim: 'gray',
      subtle: '#5f7a63',
      selBg: '#0f2b16',
      border: '#166534',
      barEmpty: '#274435',
      providerColors: { piratebay: '#6ee7b7', '1337x': '#4ade80', nyaa: '#a3e635' }
    }
  },
  sunset: {
    id: 'sunset',
    label: 'sunset',
    description: 'warm orange → pink dusk',
    spec: {
      gradient: ['#fef3c7', '#fde68a', '#fbbf24', '#fb923c', '#f87171', '#f472b6'],
      pink: '#f9a8d4',
      violet: '#fb923c',
      indigo: '#f59e0b',
      cyan: '#fbbf24',
      blue: '#fb7185',
      green: '#86efac',
      lime: '#d9f99d',
      yellow: '#fde047',
      red: '#f87171',
      dim: 'gray',
      subtle: '#a1887f',
      selBg: '#3f1d2b',
      border: '#b45309',
      barEmpty: '#5c4a44',
      providerColors: { piratebay: '#fbbf24', '1337x': '#fb923c', nyaa: '#f472b6' }
    }
  },
  ocean: {
    id: 'ocean',
    label: 'ocean',
    description: 'deep blue tide',
    spec: {
      gradient: ['#e0f2fe', '#a5f3fc', '#67e8f9', '#38bdf8', '#3b82f6', '#2563eb'],
      pink: '#bae6fd',
      violet: '#7dd3fc',
      indigo: '#60a5fa',
      cyan: '#22d3ee',
      blue: '#3b82f6',
      green: '#4ade80',
      lime: '#a3e635',
      yellow: '#fbbf24',
      red: '#f87171',
      dim: 'gray',
      subtle: '#688ba3',
      selBg: '#0c2a3f',
      border: '#0369a1',
      barEmpty: '#334e5e',
      providerColors: { piratebay: '#22d3ee', '1337x': '#60a5fa', nyaa: '#a5f3fc' }
    }
  },
  ember: {
    id: 'ember',
    label: 'ember',
    description: 'crimson coals',
    spec: {
      gradient: ['#fecaca', '#fca5a5', '#f87171', '#ef4444', '#dc2626', '#b91c1c'],
      pink: '#fda4af',
      violet: '#fb7185',
      indigo: '#f87171',
      cyan: '#fbbf24',
      blue: '#fb923c',
      green: '#4ade80',
      lime: '#a3e635',
      yellow: '#fbbf24',
      red: '#f87171',
      dim: 'gray',
      subtle: '#9c6b6b',
      selBg: '#3b0d0d',
      border: '#b91c1c',
      barEmpty: '#5e3333',
      providerColors: { piratebay: '#fbbf24', '1337x': '#f87171', nyaa: '#fda4af' }
    }
  },
  candy: {
    id: 'candy',
    label: 'candy',
    description: 'pastel sugar',
    spec: {
      gradient: ['#ffe4f2', '#fbcfe8', '#f0abfc', '#d8b4fe', '#a5b4fc', '#a5f3fc'],
      pink: '#f9a8d4',
      violet: '#d8b4fe',
      indigo: '#a5b4fc',
      cyan: '#a5f3fc',
      blue: '#93c5fd',
      green: '#86efac',
      lime: '#bef264',
      yellow: '#fde68a',
      red: '#fca5a5',
      dim: 'gray',
      subtle: '#9b87a8',
      selBg: '#35243f',
      border: '#bd8fd8',
      barEmpty: '#574a63',
      providerColors: { piratebay: '#a5f3fc', '1337x': '#d8b4fe', nyaa: '#f9a8d4' }
    }
  },
  amber: {
    id: 'amber',
    label: 'amber',
    description: 'retro amber terminal',
    spec: {
      gradient: ['#fef9c3', '#fde047', '#facc15', '#eab308', '#ca8a04', '#a16207'],
      pink: '#fde68a',
      violet: '#facc15',
      indigo: '#eab308',
      cyan: '#fcd34d',
      blue: '#d97706',
      green: '#a3e635',
      lime: '#bef264',
      yellow: '#fde047',
      red: '#f87171',
      dim: 'gray',
      subtle: '#a08a5c',
      selBg: '#33270a',
      border: '#b45309',
      barEmpty: '#5c4f2e',
      providerColors: { piratebay: '#fde047', '1337x': '#eab308', nyaa: '#fcd34d' }
    }
  },
  mono: {
    id: 'mono',
    label: 'mono',
    description: 'paper-white minimal',
    spec: {
      gradient: ['#ffffff', '#e5e5e5', '#d4d4d4', '#a3a3a3', '#8a8a8a', '#737373'],
      pink: '#f5f5f5',
      violet: '#e5e5e5',
      indigo: '#d4d4d4',
      cyan: '#fafafa',
      blue: '#a3a3a3',
      green: '#d4d4d4',
      lime: '#d4d4d4',
      yellow: '#e5e5e5',
      red: '#f87171',
      dim: 'gray',
      subtle: '#8a8a8a',
      selBg: '#2b2b2b',
      border: '#6b6b6b',
      barEmpty: '#4d4d4d',
      providerColors: { piratebay: '#d4d4d4', '1337x': '#a3a3a3', nyaa: '#f5f5f5' }
    }
  }
}

export const DEFAULT_THEME_ID = 'rain'

/** Friendly aliases accepted for `/theme <name>` and --theme. */
const THEME_ALIASES: Record<string, string> = {
  default: DEFAULT_THEME_ID,
  rain: 'rain',
  violet: 'rain',
  matrix: 'matrix',
  green: 'matrix',
  hacker: 'matrix',
  sunset: 'sunset',
  orange: 'sunset',
  ocean: 'ocean',
  blue: 'ocean',
  ember: 'ember',
  red: 'ember',
  blood: 'ember',
  candy: 'candy',
  pastel: 'candy',
  pink: 'candy',
  amber: 'amber',
  gold: 'amber',
  mono: 'mono',
  monochrome: 'mono',
  white: 'mono',
  light: 'mono'
}

let currentThemeId = DEFAULT_THEME_ID

/** Baseline provider chip colors so skin overrides never accumulate. */
const baselineProviderColors: Record<string, string> = { ...PROVIDER_COLORS }

export function getTheme(): ThemeSpec {
  return THEME
}

/** Currently active skin id. */
export function themeId(): string {
  return currentThemeId
}

/** All skins in presentation order. */
export function themeList(): ThemeEntry[] {
  return Object.values(THEMES)
}

/** Resolve a user-typed theme name (or alias) to a known skin id. */
export function normalizeThemeName(name: string): string | null {
  const key = name.trim().toLowerCase()
  if (key.length === 0) return null
  const resolved = THEME_ALIASES[key] ?? key
  return THEMES[resolved] ? resolved : null
}

/**
 * Activate a skin by id (must exist — callers should resolve via
 * normalizeThemeName first). Overwrites the THEME singleton in place and
 * repaints provider chip colors (resetting overrides from the previous
 * skin first, so switching skins never leaks colors).
 */
export function setTheme(id: string): string {
  const entry = THEMES[id]
  if (!entry) throw new Error(`unknown theme "${id}"`)
  const { providerColors, ...core } = entry.spec
  for (const key of Object.keys(THEME) as Array<keyof ThemeSpec>) {
    delete THEME[key]
  }
  Object.assign(THEME, core)
  for (const key of Object.keys(PROVIDER_COLORS)) delete PROVIDER_COLORS[key]
  Object.assign(PROVIDER_COLORS, baselineProviderColors, providerColors ?? {})
  currentThemeId = entry.id
  return entry.id
}
