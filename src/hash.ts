import type { TemplateRecord } from '../shared/types'

// Small, fast string hash (djb2 xor variant). Used only for change detection
// in skip-unchanged — not for security. The server stores and compares the
// value opaquely, so only the client needs to compute it.
function djb2(str: string): string {
  let h = 5381
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i)
  }
  return (h >>> 0).toString(36)
}

// A (company, template) pair is "unchanged" only if nothing that affects the
// rendered pixels changed: the template config, the background file it points
// at, the global logo asset, and the exact display name. Replacing a
// background or the logo changes the path (new timestamped filename), which
// invalidates exactly the affected renders.
export function renderHash(template: TemplateRecord, displayName: string, logoPath: string | null): string {
  return djb2(`${JSON.stringify(template.config)}|${template.backgroundPath}|${logoPath ?? ''}|${displayName}`)
}
