import type { TemplateConfig } from '../shared/types'

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

// A (company, template) is "unchanged" when its template config and the exact
// rendered display name both match the last successful generation.
export function configHash(config: TemplateConfig, displayName: string): string {
  return djb2(`${JSON.stringify(config)}|${displayName}`)
}
