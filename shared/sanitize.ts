// Transliterate diacritics and non-decomposable letters, spaces to
// underscores, strip anything outside [A-Za-z0-9_-]. Used for folder and
// file names only — rendered text always uses the real name.

const SPECIAL: Record<string, string> = {
  ø: 'o', Ø: 'O',
  æ: 'ae', Æ: 'AE',
  œ: 'oe', Œ: 'OE',
  ß: 'ss',
  ð: 'd', Ð: 'D',
  þ: 'th', Þ: 'TH',
  đ: 'd', Đ: 'D',
  ł: 'l', Ł: 'L',
}

export function sanitizeName(name: string): string {
  let s = name.trim()
  s = Array.from(s).map((c) => SPECIAL[c] ?? c).join('')
  // Å/Ä/Ö/å/ä/ö, é, ü, etc. decompose to base letter + combining mark.
  s = s.normalize('NFKD').replace(/\p{M}/gu, '')
  s = s.replace(/\s+/g, '_')
  s = s.replace(/[^A-Za-z0-9_-]/g, '')
  return s || 'Unnamed'
}
