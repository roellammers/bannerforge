// Shared between server and frontend. All coordinates and sizes are in
// FINAL pixel space (1x). Rendering multiplies by SCALE=2 internally.

export interface TextStyle {
  fontSize: number
  fontWeight: number
  lineHeight: number // multiplier of fontSize
  letterSpacing: number // px at 1x
  color: string
  align: 'left' | 'center' | 'right'
}

export interface HeadlineConfig {
  // May contain the {company} token and manual line breaks (\n).
  pattern: string
  x: number
  y: number
  maxWidth: number
  // Auto-shrink box height. If the wrapped headline exceeds maxWidth or
  // maxHeight, the font size is reduced in steps down to the floor.
  maxHeight: number
  style: TextStyle
  // The {company} span carries its own color/weight so a future creative can invert the rule.
  companyStyle: { color: string; fontWeight: number }
  // Auto-shrink floor as fraction of base font size (default 0.8).
  shrinkFloor: number
}

export interface StatConfig {
  statText: string
  subText: string
  x: number
  y: number
  maxWidth: number
  statStyle: TextStyle
  subStyle: TextStyle
  gap: number // px between stat bottom and sub-line top
  positionMode: 'absolute' | 'follow-headline'
  followGap: number // px below headline bottom when following
}

export interface LogoConfig {
  x: number
  y: number
  width: number // height follows the asset's aspect ratio
}

export interface TemplateConfig {
  headline: HeadlineConfig
  stat: StatConfig
  logo: LogoConfig
}

export interface TemplateRecord {
  id: number
  creative: string
  width: number
  height: number
  backgroundPath: string // relative URL under /assets
  bgWidth: number
  bgHeight: number
  config: TemplateConfig
  updatedAt: string
}

export interface Company {
  id: number
  name: string
  displayOverride: string | null
}

export interface BannerSize {
  id: number
  width: number
  height: number
}

export interface Palette {
  mainGreen: string
  marigold: string
  darkGreen: string
  brightSnow: string
}

export interface AppSettings {
  outputDir: string
  palette: Palette
  logoPath: string | null // relative URL under /assets
  monthlyLimit: number // Tinify plan limit (Phase 4)
}

export const DEFAULT_PALETTE: Palette = {
  mainGreen: '#124131',
  marigold: '#ECA400',
  darkGreen: '#238061',
  brightSnow: '#F9FAFA',
}

export const DEFAULT_SIZES: Array<[number, number]> = [
  [300, 250],
  [300, 600],
  [320, 320],
  [320, 480],
  [980, 400],
]

export function defaultTemplateConfig(width: number, height: number, palette: Palette): TemplateConfig {
  const pad = Math.round(Math.min(width, height) * 0.08)
  const headlineSize = Math.max(16, Math.round(Math.min(width, height) * 0.085))
  const statSize = Math.max(22, Math.round(Math.min(width, height) * 0.14))
  const subSize = Math.max(12, Math.round(Math.min(width, height) * 0.055))
  const baseText = (size: number, weight: number, color: string): TextStyle => ({
    fontSize: size,
    fontWeight: weight,
    lineHeight: 1.15,
    letterSpacing: 0,
    color,
    align: 'left',
  })
  return {
    headline: {
      pattern: 'Built for {company}',
      x: pad,
      y: pad,
      maxWidth: width - pad * 2,
      maxHeight: Math.round(headlineSize * 1.15 * 3), // ~3 lines at base size
      style: baseText(headlineSize, 700, palette.mainGreen),
      companyStyle: { color: palette.marigold, fontWeight: 700 },
      shrinkFloor: 0.8,
    },
    stat: {
      statText: '92%',
      subText: 'Faster case handling.',
      x: pad,
      y: Math.round(height * 0.45),
      maxWidth: width - pad * 2,
      statStyle: baseText(statSize, 800, palette.mainGreen),
      subStyle: baseText(subSize, 600, palette.mainGreen),
      gap: 4,
      positionMode: 'absolute',
      followGap: 16,
    },
    logo: {
      x: pad,
      y: height - pad - Math.round(height * 0.09),
      width: Math.round(width * 0.28),
    },
  }
}

// Fills fields added after some templates were first saved, so old configs
// stay valid. Mutates and returns the same object.
export function normalizeConfig(config: TemplateConfig): TemplateConfig {
  const h = config.headline
  if (typeof h.maxHeight !== 'number' || h.maxHeight <= 0) {
    h.maxHeight = Math.round(h.style.fontSize * h.style.lineHeight * 3)
  }
  if (typeof h.shrinkFloor !== 'number' || h.shrinkFloor <= 0 || h.shrinkFloor > 1) {
    h.shrinkFloor = 0.8
  }
  return config
}
