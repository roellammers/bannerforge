// Canvas silently falls back to a default font if the face has not finished
// loading, so every render path awaits this first.
export async function ensureFonts(weights: number[]): Promise<void> {
  const unique = [...new Set(weights.filter((w) => w >= 100 && w <= 900))]
  await Promise.all(unique.map((w) => document.fonts.load(`${w} 32px Inter`)))
  await document.fonts.ready
}

export function configFontWeights(config: {
  headline: { style: { fontWeight: number }; companyStyle: { fontWeight: number } }
  stat: { statStyle: { fontWeight: number }; subStyle: { fontWeight: number } }
}): number[] {
  return [
    config.headline.style.fontWeight,
    config.headline.companyStyle.fontWeight,
    config.stat.statStyle.fontWeight,
    config.stat.subStyle.fontWeight,
  ]
}
