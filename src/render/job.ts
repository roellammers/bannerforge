import type { TemplateRecord } from '../../shared/types'
import { canvasToPngBlob, loadImage, renderTemplate } from './engine'
import { configFontWeights, ensureFonts } from './fonts'

export interface RenderedJob {
  blob: Blob
  dataUrl: string
  overflow: boolean
  scale: number
}

// Renders one template for one display name at final pixel size, returning
// both the PNG blob (to write) and a data URL (for preview/review thumbnails).
// Shared by the single-company and batch flows so they render identically.
export async function renderJob(
  template: TemplateRecord,
  displayName: string,
  logo: HTMLImageElement | null,
  canvas: HTMLCanvasElement
): Promise<RenderedJob> {
  await ensureFonts(configFontWeights(template.config))
  const background = await loadImage(`/assets/${template.backgroundPath}`)
  const metrics = renderTemplate({
    config: template.config,
    width: template.width,
    height: template.height,
    company: displayName,
    background,
    logo,
    target: canvas,
  })
  const blob = await canvasToPngBlob(canvas)
  const dataUrl = canvas.toDataURL('image/png')
  return { blob, dataUrl, overflow: metrics.headlineOverflow, scale: metrics.headlineScale }
}

export function displayNameOf(c: { name: string; displayOverride: string | null }): string {
  return c.displayOverride?.trim() || c.name
}
