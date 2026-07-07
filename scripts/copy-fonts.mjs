// Copies the Inter variable font (all weights 100-900) from
// @fontsource-variable/inter into public/fonts so it is served locally.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(root, 'node_modules', '@fontsource-variable', 'inter', 'files')
const dest = path.join(root, 'public', 'fonts')

const files = ['inter-latin-wght-normal.woff2', 'inter-latin-ext-wght-normal.woff2']

fs.mkdirSync(dest, { recursive: true })
let copied = 0
for (const f of files) {
  const from = path.join(src, f)
  if (fs.existsSync(from)) {
    fs.copyFileSync(from, path.join(dest, f))
    copied++
  } else {
    console.warn(`[copy-fonts] missing ${from}`)
  }
}
console.log(`[copy-fonts] copied ${copied}/${files.length} font files to public/fonts`)
