// The render engine. Everything is drawn on an internal canvas at 2x the
// final banner size (backgrounds are uploaded as 2x exports), then downscaled
// once with high-quality smoothing. The editor preview and the exported file
// go through this exact code path, so the preview IS the render.
//
// Config coordinates are in final (1x) pixel space; this module multiplies
// by SCALE when drawing.

import type { HeadlineConfig, StatConfig, TemplateConfig, TextStyle } from '../../shared/types'

export const SCALE = 2

// ---- text layout ----

interface Token {
  text: string
  company: boolean
  width: number // measured at 2x, includes letter spacing
  spaceAfter: number // width of the following space at 2x (0 at line end)
}

interface Line {
  tokens: Token[]
  width: number
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export interface RenderMetrics {
  headline: Box
  stat: Box
  logo: Box
  headlineLines: number
  // Auto-shrink outcome for the headline.
  headlineScale: number // 1 = base size; <1 = shrunk
  headlineOverflow: boolean // true = still overflowed at the floor (flag it)
}

type Ctx = CanvasRenderingContext2D

function fontString(weight: number, sizePx: number): string {
  return `${weight} ${sizePx}px Inter, sans-serif`
}

function applyStyle(ctx: Ctx, style: TextStyle, weight: number, color: string): void {
  ctx.font = fontString(weight, style.fontSize * SCALE)
  // Supported in Chromium; affects both measureText and fillText.
  ctx.letterSpacing = `${style.letterSpacing * SCALE}px`
  ctx.fillStyle = color
}

function headlineTokenStyle(ctx: Ctx, cfg: HeadlineConfig, company: boolean): void {
  if (company) {
    applyStyle(ctx, cfg.style, cfg.companyStyle.fontWeight, cfg.companyStyle.color)
  } else {
    applyStyle(ctx, cfg.style, cfg.style.fontWeight, cfg.style.color)
  }
}

interface WordInput {
  word: string
  company: boolean
  // Whether whitespace separated this word from the previous one. false means
  // it directly abuts the previous token (e.g. the "." in "{company}." or the
  // "'s" in "{company}'s") and must render with no space and never wrap away.
  spaceBefore: boolean
}

// Splits a headline pattern into paragraphs (explicit \n) of word segments,
// each flagged as company text or not, preserving whitespace adjacency so
// punctuation touching {company} stays attached with no inserted space.
function segmentPattern(pattern: string, company: string): WordInput[][] {
  return pattern.split('\n').map((paragraph) => {
    const words: WordInput[] = []
    const parts = paragraph.split('{company}')
    parts.forEach((part, i) => {
      const startsWithSpace = /^\s/.test(part)
      const endsWithSpace = /\s$/.test(part)
      part
        .split(/\s+/)
        .filter(Boolean)
        .forEach((w, j) => {
          // First word of the part inherits adjacency from the preceding
          // {company} boundary (startsWithSpace); later words are space-split.
          const spaceBefore = j > 0 || words.length === 0 ? true : startsWithSpace
          words.push({ word: w, company: false, spaceBefore })
        })
      if (i < parts.length - 1) {
        company
          .split(/\s+/)
          .filter(Boolean)
          .forEach((w, j) => {
            const spaceBefore = j > 0 || words.length === 0 ? true : endsWithSpace
            words.push({ word: w, company: true, spaceBefore })
          })
      }
    })
    return words
  })
}

// Greedy word wrap. A single word wider than maxWidth is kept on its own line
// and allowed to overflow (auto-shrink + flagging handle that). Words with
// spaceBefore=false glue to the previous token: no leading space, no wrap.
function wrapWords(
  ctx: Ctx,
  words: WordInput[],
  maxWidth2x: number,
  setTokenStyle: (company: boolean) => void
): Line[] {
  const lines: Line[] = []
  let current: Token[] = []
  let currentWidth = 0

  for (const { word, company, spaceBefore } of words) {
    setTokenStyle(company)
    const wordWidth = ctx.measureText(word).width
    const spaceWidth = ctx.measureText(' ').width
    if (current.length > 0 && !spaceBefore) {
      // Glued token: attach to the current line with no space, no wrap break.
      current.push({ text: word, company, width: wordWidth, spaceAfter: 0 })
      currentWidth += wordWidth
      continue
    }
    const extra = current.length > 0 ? spaceWidth + wordWidth : wordWidth
    if (current.length > 0 && currentWidth + extra > maxWidth2x) {
      lines.push({ tokens: current, width: currentWidth })
      current = []
      currentWidth = 0
    }
    if (current.length > 0) {
      current[current.length - 1].spaceAfter = spaceWidth
      currentWidth += spaceWidth
    }
    current.push({ text: word, company, width: wordWidth, spaceAfter: 0 })
    currentWidth += wordWidth
  }
  if (current.length > 0) lines.push({ tokens: current, width: currentWidth })
  return lines
}

function ascentFor(ctx: Ctx, style: TextStyle, weight: number): number {
  ctx.font = fontString(weight, style.fontSize * SCALE)
  const m = ctx.measureText('Mg')
  return m.fontBoundingBoxAscent || style.fontSize * SCALE * 0.8
}

// Draws a wrapped text block; returns the drawn box in 1x space.
// Lines are laid out on a fixed grid of lineHeight * fontSize.
function drawLines(ctx: Ctx, lines: Line[], opts: { x: number; y: number; maxWidth: number; style: TextStyle; ascent: number; setTokenStyle: (company: boolean) => void }): Box {
  const { x, y, maxWidth, style, ascent, setTokenStyle } = opts
  const lineHeight2x = style.lineHeight * style.fontSize * SCALE
  const x2 = x * SCALE
  const maxWidth2x = maxWidth * SCALE

  lines.forEach((line, i) => {
    let dx = x2
    if (style.align === 'center') dx = x2 + (maxWidth2x - line.width) / 2
    if (style.align === 'right') dx = x2 + maxWidth2x - line.width
    const baseline = y * SCALE + i * lineHeight2x + ascent
    for (const token of line.tokens) {
      setTokenStyle(token.company)
      ctx.fillText(token.text, dx, baseline)
      dx += token.width + token.spaceAfter
    }
  })

  const height = (lines.length * lineHeight2x) / SCALE
  return { x, y, width: maxWidth, height }
}

function layoutHeadline(ctx: Ctx, cfg: HeadlineConfig, company: string): Line[] {
  const paragraphs = segmentPattern(cfg.pattern, company)
  const lines: Line[] = []
  for (const words of paragraphs) {
    if (words.length === 0) {
      lines.push({ tokens: [], width: 0 }) // blank manual line
      continue
    }
    lines.push(...wrapWords(ctx, words, cfg.maxWidth * SCALE, (c) => headlineTokenStyle(ctx, cfg, c)))
  }
  return lines
}

interface HeadlineFit {
  lines: Line[]
  scaledCfg: HeadlineConfig
  scale: number
  overflow: boolean
}

// Auto-shrink: lay out at 100%, and if the wrapped text exceeds the max
// width (a word too long to wrap) or the max height (too many lines), step
// the font size down in 5% increments to the floor. If it still overflows at
// the floor, keep the floor layout and report overflow so the caller can flag
// the company+template for the review queue.
function fitHeadline(ctx: Ctx, cfg: HeadlineConfig, company: string): HeadlineFit {
  const floor = cfg.shrinkFloor > 0 && cfg.shrinkFloor <= 1 ? cfg.shrinkFloor : 0.8
  const maxWidth2x = cfg.maxWidth * SCALE
  const maxHeight2x = cfg.maxHeight * SCALE

  const scales: number[] = []
  for (let s = 1; s > floor + 1e-9; s -= 0.05) scales.push(s)
  scales.push(floor)

  let last: { lines: Line[]; scaledCfg: HeadlineConfig; scale: number } | null = null
  for (const scale of scales) {
    const scaledCfg: HeadlineConfig = { ...cfg, style: { ...cfg.style, fontSize: cfg.style.fontSize * scale } }
    const lines = layoutHeadline(ctx, scaledCfg, company)
    last = { lines, scaledCfg, scale }
    const lineHeight2x = scaledCfg.style.lineHeight * scaledCfg.style.fontSize * SCALE
    const totalHeight2x = lines.length * lineHeight2x
    const widthFits = lines.every((l) => l.width <= maxWidth2x + 0.5)
    const heightFits = totalHeight2x <= maxHeight2x + 0.5
    if (widthFits && heightFits) return { lines, scaledCfg, scale, overflow: false }
  }
  return { lines: last!.lines, scaledCfg: last!.scaledCfg, scale: last!.scale, overflow: true }
}

function drawHeadline(ctx: Ctx, cfg: HeadlineConfig, company: string): { box: Box; fit: HeadlineFit } {
  const fit = fitHeadline(ctx, cfg, company)
  const sc = fit.scaledCfg
  const ascent = ascentFor(ctx, sc.style, sc.style.fontWeight)
  const box = drawLines(ctx, fit.lines, {
    x: sc.x,
    y: sc.y,
    maxWidth: sc.maxWidth,
    style: sc.style,
    ascent,
    setTokenStyle: (c) => headlineTokenStyle(ctx, sc, c),
  })
  return { box, fit }
}

// Single-style block (stat / sub-line). Supports wrapping and manual \n.
// Empty text collapses to zero height so a stat block can act as a single
// headline-style line (stat-only or sub-only).
function drawPlainBlock(ctx: Ctx, text: string, x: number, y: number, maxWidth: number, style: TextStyle): Box {
  if (!text.trim()) return { x, y, width: maxWidth, height: 0 }
  const setStyle = () => applyStyle(ctx, style, style.fontWeight, style.color)
  const lines: Line[] = []
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean).map((word) => ({ word, company: false, spaceBefore: true }))
    if (words.length === 0) {
      lines.push({ tokens: [], width: 0 })
      continue
    }
    lines.push(...wrapWords(ctx, words, maxWidth * SCALE, setStyle))
  }
  const ascent = ascentFor(ctx, style, style.fontWeight)
  return drawLines(ctx, lines, { x, y, maxWidth, style, ascent, setTokenStyle: setStyle })
}

function drawStat(ctx: Ctx, cfg: StatConfig, headlineBox: Box): Box {
  const y = cfg.positionMode === 'follow-headline' ? headlineBox.y + headlineBox.height + cfg.followGap : cfg.y
  const statBox = drawPlainBlock(ctx, cfg.statText, cfg.x, y, cfg.maxWidth, cfg.statStyle)
  const gap = statBox.height > 0 && cfg.subText.trim() ? cfg.gap : 0
  const subY = y + statBox.height + gap
  const subBox = drawPlainBlock(ctx, cfg.subText, cfg.x, subY, cfg.maxWidth, cfg.subStyle)
  return { x: cfg.x, y, width: cfg.maxWidth, height: subY + subBox.height - y }
}

// ---- full render ----

export interface RenderInput {
  config: TemplateConfig
  width: number
  height: number
  company: string
  background: HTMLImageElement | null
  logo: HTMLImageElement | null
  target: HTMLCanvasElement
  // 1 = final export size (default); 2 shows the internal 2x render 1:1,
  // for a larger editor preview. Exports must use 1.
  displayScale?: number
}

export function renderTemplate(input: RenderInput): RenderMetrics {
  const { config, width, height, company, background, logo, target } = input
  const displayScale = input.displayScale ?? 1
  const big = document.createElement('canvas')
  big.width = width * SCALE
  big.height = height * SCALE
  const ctx = big.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D context unavailable')
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'

  if (background) {
    ctx.drawImage(background, 0, 0, big.width, big.height)
  } else {
    ctx.fillStyle = '#e8e8e8'
    ctx.fillRect(0, 0, big.width, big.height)
  }

  const { box: headlineBox, fit } = drawHeadline(ctx, config.headline, company)
  const statBox = drawStat(ctx, config.stat, headlineBox)

  let logoBox: Box = { x: config.logo.x, y: config.logo.y, width: config.logo.width, height: config.logo.width }
  if (logo) {
    const aspect = logo.naturalWidth > 0 ? logo.naturalHeight / logo.naturalWidth : 1
    const h = config.logo.width * aspect
    ctx.drawImage(logo, config.logo.x * SCALE, config.logo.y * SCALE, config.logo.width * SCALE, h * SCALE)
    logoBox = { x: config.logo.x, y: config.logo.y, width: config.logo.width, height: h }
  }

  // Single high-quality downscale to the display size (at displayScale 2
  // this is a 1:1 copy of the internal 2x render).
  target.width = width * displayScale
  target.height = height * displayScale
  const tctx = target.getContext('2d')
  if (!tctx) throw new Error('Canvas 2D context unavailable')
  tctx.imageSmoothingEnabled = true
  tctx.imageSmoothingQuality = 'high'
  tctx.clearRect(0, 0, target.width, target.height)
  tctx.drawImage(big, 0, 0, target.width, target.height)

  return {
    headline: headlineBox,
    stat: statBox,
    logo: logoBox,
    headlineLines: fit.lines.length,
    headlineScale: fit.scale,
    headlineOverflow: fit.overflow,
  }
}

export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), 'image/png')
  })
}

const imageCache = new Map<string, Promise<HTMLImageElement>>()

export function loadImage(url: string): Promise<HTMLImageElement> {
  let cached = imageCache.get(url)
  if (!cached) {
    cached = new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error(`Failed to load image: ${url}`))
      img.src = url
    })
    imageCache.set(url, cached)
  }
  return cached
}
