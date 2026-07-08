import express from 'express'
import multer from 'multer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { db, getSetting, setSetting, ASSETS_DIR, BACKGROUNDS_DIR, ROOT } from './db.js'
import { compressPng, isConfigured as tinifyConfigured, tinifyStatus } from './tinify.js'

// Load TINIFY_API_KEY (and friends) from .env; fine if the file doesn't exist.
try {
  process.loadEnvFile(path.join(ROOT, '.env'))
} catch {
  /* no .env yet */
}
import { sanitizeName } from '../shared/sanitize.js'
import {
  defaultTemplateConfig,
  normalizeConfig,
  DEFAULT_PALETTE,
  type AppSettings,
  type Palette,
  type TemplateConfig,
  type TemplateRecord,
} from '../shared/types.js'

const app = express()
app.use(express.json({ limit: '5mb' }))
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } })

app.use('/assets', express.static(ASSETS_DIR))

// ---- helpers ----

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG)) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

interface TemplateRow {
  id: number
  creative: string
  width: number
  height: number
  background_path: string
  bg_width: number
  bg_height: number
  config: string
  updated_at: string
}

function rowToTemplate(row: TemplateRow): TemplateRecord {
  return {
    id: row.id,
    creative: row.creative,
    width: row.width,
    height: row.height,
    backgroundPath: row.background_path,
    bgWidth: row.bg_width,
    bgHeight: row.bg_height,
    config: normalizeConfig(JSON.parse(row.config) as TemplateConfig),
    updatedAt: row.updated_at,
  }
}

function currentSettings(): AppSettings {
  let palette: Palette
  try {
    palette = { ...DEFAULT_PALETTE, ...JSON.parse(getSetting('palette') ?? '{}') }
  } catch {
    palette = DEFAULT_PALETTE
  }
  return {
    outputDir: getSetting('output_dir') ?? '',
    palette,
    logoPath: getSetting('logo_path'),
    monthlyLimit: Number(getSetting('monthly_limit') ?? '500'),
  }
}

// ---- sizes ----

app.get('/api/sizes', (_req, res) => {
  res.json(db.prepare('SELECT id, width, height FROM sizes ORDER BY width, height').all())
})

app.post('/api/sizes', (req, res) => {
  const width = Number(req.body.width)
  const height = Number(req.body.height)
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return res.status(400).json({ error: 'width and height must be positive integers' })
  }
  db.prepare('INSERT OR IGNORE INTO sizes (width, height) VALUES (?, ?)').run(width, height)
  res.json(db.prepare('SELECT id, width, height FROM sizes ORDER BY width, height').all())
})

// Removing a size only trims the upload dropdown; existing templates that use
// the size are untouched.
app.delete('/api/sizes/:id', (req, res) => {
  const info = db.prepare('DELETE FROM sizes WHERE id = ?').run(req.params.id)
  if (info.changes === 0) return res.status(404).json({ error: 'Size not found' })
  res.json(db.prepare('SELECT id, width, height FROM sizes ORDER BY width, height').all())
})

// ---- settings ----

app.get('/api/settings', (_req, res) => {
  res.json(currentSettings())
})

// Users paste paths like "~/Google Drive/Ads" or leave them relative; store
// a resolved absolute path so file writes land where they expect.
function normalizeDir(p: string): string {
  let s = p.trim()
  if (s === '~') s = os.homedir()
  else if (s.startsWith('~/')) s = path.join(os.homedir(), s.slice(2))
  return path.isAbsolute(s) ? path.normalize(s) : path.resolve(ROOT, s)
}

app.put('/api/settings', (req, res) => {
  const { outputDir, palette, monthlyLimit } = req.body as Partial<AppSettings>
  if (typeof outputDir === 'string' && outputDir.trim()) setSetting('output_dir', normalizeDir(outputDir))
  if (palette && typeof palette === 'object') setSetting('palette', JSON.stringify(palette))
  if (typeof monthlyLimit === 'number' && monthlyLimit > 0) setSetting('monthly_limit', String(monthlyLimit))
  res.json(currentSettings())
})

// ---- logo ----

app.post('/api/logo', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  const original = req.file.originalname.toLowerCase()
  const ext = original.endsWith('.svg') ? 'svg' : original.endsWith('.png') ? 'png' : null
  if (!ext) return res.status(400).json({ error: 'Logo must be SVG or PNG' })
  if (ext === 'png' && !pngSize(req.file.buffer)) {
    return res.status(400).json({ error: 'File is not a valid PNG' })
  }
  if (ext === 'svg' && !req.file.buffer.toString('utf8', 0, 4096).includes('<svg')) {
    return res.status(400).json({ error: 'File is not a valid SVG' })
  }
  const previous = getSetting('logo_path')
  const filename = `logo-${Date.now()}.${ext}`
  fs.writeFileSync(path.join(ASSETS_DIR, filename), req.file.buffer)
  setSetting('logo_path', filename)
  if (previous && previous !== filename) {
    fs.rm(path.join(ASSETS_DIR, previous), { force: true }, () => {})
  }
  res.json({ logoPath: filename })
})

// ---- templates ----

app.get('/api/templates', (_req, res) => {
  const rows = db
    .prepare('SELECT * FROM templates ORDER BY creative, width, height')
    .all() as TemplateRow[]
  res.json(rows.map(rowToTemplate))
})

app.get('/api/templates/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id) as TemplateRow | undefined
  if (!row) return res.status(404).json({ error: 'Template not found' })
  res.json(rowToTemplate(row))
})

app.post('/api/templates', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  const creative = String(req.body.creative ?? '').trim()
  const width = Number(req.body.width)
  const height = Number(req.body.height)
  const replace = req.body.replace === '1'
  if (!creative) return res.status(400).json({ error: 'Creative name is required' })
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return res.status(400).json({ error: 'Invalid width/height' })
  }

  const dims = pngSize(req.file.buffer)
  if (!dims) return res.status(400).json({ error: 'File is not a valid PNG' })
  const is2x = dims.width === width * 2 && dims.height === height * 2

  const existing = db
    .prepare('SELECT * FROM templates WHERE creative = ? AND width = ? AND height = ?')
    .get(creative, width, height) as TemplateRow | undefined
  if (existing && !replace) {
    return res.status(409).json({ error: 'exists', id: existing.id })
  }

  const filename = `${sanitizeName(creative)}_${width}x${height}_${Date.now()}.png`
  fs.writeFileSync(path.join(BACKGROUNDS_DIR, filename), req.file.buffer)
  const backgroundPath = `backgrounds/${filename}`

  let id: number
  if (existing) {
    // Replacing the background keeps the element layout.
    const old = path.join(ASSETS_DIR, existing.background_path)
    db.prepare(
      `UPDATE templates SET background_path = ?, bg_width = ?, bg_height = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(backgroundPath, dims.width, dims.height, existing.id)
    id = existing.id
    fs.rm(old, { force: true }, () => {})
  } else {
    const config = defaultTemplateConfig(width, height, currentSettings().palette)
    const info = db
      .prepare(
        'INSERT INTO templates (creative, width, height, background_path, bg_width, bg_height, config) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(creative, width, height, backgroundPath, dims.width, dims.height, JSON.stringify(config))
    id = Number(info.lastInsertRowid)
  }

  const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow
  res.json({ template: rowToTemplate(row), is2x, actual: dims })
})

app.put('/api/templates/:id/config', (req, res) => {
  const { config } = req.body as { config: TemplateConfig }
  if (!config || !config.headline || !config.stat || !config.logo) {
    return res.status(400).json({ error: 'Invalid config' })
  }
  const info = db
    .prepare(`UPDATE templates SET config = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(JSON.stringify(config), req.params.id)
  if (info.changes === 0) return res.status(404).json({ error: 'Template not found' })
  const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id) as TemplateRow
  res.json(rowToTemplate(row))
})

// Duplicates every template of a creative into a new creative name, copying
// each background file (rows own their files, so deletes stay independent).
// Optional text overrides let a new headline/stat combo be set in one go.
app.post('/api/creatives/duplicate', (req, res) => {
  const source = String(req.body.source ?? '').trim()
  const target = String(req.body.target ?? '').trim()
  const { headlinePattern, statText, subText } = req.body as {
    headlinePattern?: string
    statText?: string
    subText?: string
  }
  if (!source || !target) return res.status(400).json({ error: 'source and target creative names are required' })
  if (source === target) return res.status(400).json({ error: 'New creative name must differ from the source' })

  const rows = db.prepare('SELECT * FROM templates WHERE creative = ? ORDER BY width, height').all(source) as TemplateRow[]
  if (rows.length === 0) return res.status(404).json({ error: `No templates found for creative "${source}"` })
  const clash = db.prepare('SELECT COUNT(*) AS n FROM templates WHERE creative = ?').get(target) as { n: number }
  if (clash.n > 0) return res.status(409).json({ error: `Creative "${target}" already exists` })

  const created: TemplateRecord[] = []
  for (const row of rows) {
    const config = JSON.parse(row.config) as TemplateConfig
    if (typeof headlinePattern === 'string') config.headline.pattern = headlinePattern
    if (typeof statText === 'string') config.stat.statText = statText
    if (typeof subText === 'string') config.stat.subText = subText

    const filename = `${sanitizeName(target)}_${row.width}x${row.height}_${Date.now()}.png`
    fs.copyFileSync(path.join(ASSETS_DIR, row.background_path), path.join(BACKGROUNDS_DIR, filename))
    const info = db
      .prepare(
        'INSERT INTO templates (creative, width, height, background_path, bg_width, bg_height, config) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(target, row.width, row.height, `backgrounds/${filename}`, row.bg_width, row.bg_height, JSON.stringify(config))
    const newRow = db.prepare('SELECT * FROM templates WHERE id = ?').get(info.lastInsertRowid) as TemplateRow
    created.push(rowToTemplate(newRow))
  }
  res.json({ created })
})

// Updates the ad-copy (headline pattern, stat, sub-line) across every format
// of a creative in one call. Only the text fields change — positions, styles,
// sizes, and modes stay per-template.
app.put('/api/creatives/ad-copy', (req, res) => {
  const creative = String(req.body.creative ?? '').trim()
  const { headlinePattern, statText, subText } = req.body as {
    headlinePattern?: string
    statText?: string
    subText?: string
  }
  if (!creative) return res.status(400).json({ error: 'creative is required' })
  const rows = db.prepare('SELECT * FROM templates WHERE creative = ?').all(creative) as TemplateRow[]
  if (rows.length === 0) return res.status(404).json({ error: `No templates found for creative "${creative}"` })

  const update = db.prepare(`UPDATE templates SET config = ?, updated_at = datetime('now') WHERE id = ?`)
  db.transaction(() => {
    for (const row of rows) {
      const config = JSON.parse(row.config) as TemplateConfig
      if (typeof headlinePattern === 'string') config.headline.pattern = headlinePattern
      if (typeof statText === 'string') config.stat.statText = statText
      if (typeof subText === 'string') config.stat.subText = subText
      update.run(JSON.stringify(config), row.id)
    }
  })()
  res.json({ updated: rows.length })
})

app.put('/api/creatives/rename', (req, res) => {
  const from = String(req.body.from ?? '').trim()
  const to = String(req.body.to ?? '').trim()
  if (!from || !to) return res.status(400).json({ error: 'from and to are required' })
  if (from === to) return res.status(400).json({ error: 'New name must differ' })
  const existing = db.prepare('SELECT COUNT(*) AS n FROM templates WHERE creative = ?').get(to) as { n: number }
  if (existing.n > 0) return res.status(409).json({ error: `Creative "${to}" already exists` })
  const info = db
    .prepare(`UPDATE templates SET creative = ?, updated_at = datetime('now') WHERE creative = ?`)
    .run(to, from)
  if (info.changes === 0) return res.status(404).json({ error: `No templates found for creative "${from}"` })
  res.json({ renamed: info.changes })
})

app.delete('/api/templates/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id) as TemplateRow | undefined
  if (!row) return res.status(404).json({ error: 'Template not found' })
  // run_history references templates(id); clear those rows first.
  db.transaction(() => {
    db.prepare('DELETE FROM run_history WHERE template_id = ?').run(req.params.id)
    db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id)
  })()
  fs.rm(path.join(ASSETS_DIR, row.background_path), { force: true }, () => {})
  res.json({ ok: true })
})

// ---- companies ----

app.get('/api/companies', (_req, res) => {
  const rows = db.prepare('SELECT id, name, display_override FROM companies ORDER BY name').all() as Array<{
    id: number
    name: string
    display_override: string | null
  }>
  res.json(rows.map((r) => ({ id: r.id, name: r.name, displayOverride: r.display_override })))
})

app.post('/api/companies', (req, res) => {
  const name = String(req.body.name ?? '').trim()
  if (!name) return res.status(400).json({ error: 'Company name is required' })
  db.prepare('INSERT OR IGNORE INTO companies (name) VALUES (?)').run(name)
  const row = db.prepare('SELECT id, name, display_override FROM companies WHERE name = ?').get(name) as {
    id: number
    name: string
    display_override: string | null
  }
  res.json({ id: row.id, name: row.name, displayOverride: row.display_override })
})

// Bulk insert from an import. Dedupes against existing names; returns counts.
app.post('/api/companies/bulk', (req, res) => {
  const names = Array.isArray(req.body.names) ? (req.body.names as unknown[]) : null
  if (!names) return res.status(400).json({ error: 'names array is required' })
  const insert = db.prepare('INSERT OR IGNORE INTO companies (name) VALUES (?)')
  let added = 0
  let skipped = 0
  const tx = db.transaction((list: string[]) => {
    for (const raw of list) {
      const name = String(raw ?? '').trim()
      if (!name) continue
      const info = insert.run(name)
      if (info.changes > 0) added++
      else skipped++
    }
  })
  tx(names.map((n) => String(n ?? '')))
  const total = (db.prepare('SELECT COUNT(*) AS n FROM companies').get() as { n: number }).n
  res.json({ added, skipped, total })
})

// Update the display-name override (rendered text only; file names still use
// the sanitized original). Empty string clears the override.
app.put('/api/companies/:id', (req, res) => {
  const raw = req.body.displayOverride
  const override = typeof raw === 'string' && raw.trim() ? raw.trim() : null
  const info = db
    .prepare(`UPDATE companies SET display_override = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(override, req.params.id)
  if (info.changes === 0) return res.status(404).json({ error: 'Company not found' })
  const row = db.prepare('SELECT id, name, display_override FROM companies WHERE id = ?').get(req.params.id) as {
    id: number
    name: string
    display_override: string | null
  }
  res.json({ id: row.id, name: row.name, displayOverride: row.display_override })
})

app.delete('/api/companies/:id', (req, res) => {
  // run_history references companies(id); clear those rows first.
  const info = db.transaction(() => {
    db.prepare('DELETE FROM run_history WHERE company_id = ?').run(req.params.id)
    return db.prepare('DELETE FROM companies WHERE id = ?').run(req.params.id)
  })()
  if (info.changes === 0) return res.status(404).json({ error: 'Company not found' })
  res.json({ ok: true })
})

// ---- render output ----

app.post('/api/render/write', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  const company = String(req.body.company ?? '').trim()
  const message = String(req.body.message ?? '').trim()
  const width = Number(req.body.width)
  const height = Number(req.body.height)
  if (!company || !message || !Number.isInteger(width) || !Number.isInteger(height)) {
    return res.status(400).json({ error: 'company, message, width and height are required' })
  }
  if (!pngSize(req.file.buffer)) return res.status(400).json({ error: 'File is not a valid PNG' })

  const outputDir = currentSettings().outputDir
  if (!outputDir) return res.status(500).json({ error: 'Output folder is not configured' })

  // Compress via Tinify unless dry-run. On final failure the uncompressed
  // PNG is written anyway and the error reported, so a batch never stalls.
  let buffer = req.file.buffer
  let compressed = false
  let compressionError: string | null = null
  if (req.body.compress === '1') {
    if (!tinifyConfigured()) {
      compressionError = 'TINIFY_API_KEY is not set in .env'
    } else {
      try {
        buffer = await compressPng(buffer)
        compressed = true
      } catch (e) {
        compressionError = (e as Error).message
      }
    }
  }

  const companySan = sanitizeName(company)
  const messageSan = sanitizeName(message)
  const dir = path.join(outputDir, companySan)
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `${companySan}_${messageSan}_${width}x${height}.png`)
  fs.writeFileSync(filePath, buffer)

  // Record run history for skip-unchanged when the batch runner supplies the
  // company/template ids and the config hash.
  const companyId = Number(req.body.companyId)
  const templateId = Number(req.body.templateId)
  const configHash = String(req.body.configHash ?? '')
  if (Number.isInteger(companyId) && Number.isInteger(templateId) && configHash) {
    db.prepare(
      `INSERT INTO run_history (company_id, template_id, config_hash, status, file_path)
       VALUES (?, ?, ?, 'written', ?)
       ON CONFLICT(company_id, template_id)
       DO UPDATE SET config_hash = excluded.config_hash, status = 'written', file_path = excluded.file_path, created_at = datetime('now')`
    ).run(companyId, templateId, configHash, filePath)
  }
  res.json({ path: filePath, bytes: buffer.length, compressed, compressionError })
})

// ---- Tinify ----

app.get('/api/tinify/status', (_req, res) => {
  res.json({ ...tinifyStatus(), monthlyLimit: currentSettings().monthlyLimit })
})

// Re-compress an already-written PNG in place ("Retry failed compressions").
app.post('/api/tinify/compress-file', async (req, res) => {
  const requested = String(req.body.path ?? '')
  const outputDir = path.resolve(currentSettings().outputDir)
  const target = path.resolve(requested)
  if (target !== outputDir && !target.startsWith(outputDir + path.sep)) {
    return res.status(400).json({ error: 'Path is outside the output folder' })
  }
  if (!fs.existsSync(target)) return res.status(404).json({ error: 'File not found' })
  const original = fs.readFileSync(target)
  if (!pngSize(original)) return res.status(400).json({ error: 'File is not a valid PNG' })
  try {
    const compressed = await compressPng(original)
    fs.writeFileSync(target, compressed)
    res.json({ path: target, bytes: compressed.length, saved: original.length - compressed.length })
  } catch (e) {
    res.status(502).json({ error: (e as Error).message })
  }
})

// The last successful hash per (company, template), for skip-unchanged.
app.get('/api/run-history', (_req, res) => {
  const rows = db
    .prepare(`SELECT company_id, template_id, config_hash FROM run_history WHERE status = 'written'`)
    .all() as Array<{ company_id: number; template_id: number; config_hash: string }>
  res.json(rows.map((r) => ({ companyId: r.company_id, templateId: r.template_id, configHash: r.config_hash })))
})

app.post('/api/open-folder', (req, res) => {
  const requested = String(req.body.path ?? '')
  const outputDir = path.resolve(currentSettings().outputDir)
  const target = path.resolve(requested || outputDir)
  if (target !== outputDir && !target.startsWith(outputDir + path.sep)) {
    return res.status(400).json({ error: 'Path is outside the output folder' })
  }
  if (!fs.existsSync(target)) return res.status(404).json({ error: 'Folder does not exist yet' })
  execFile('open', [target])
  res.json({ ok: true })
})

const PORT = Number(process.env.API_PORT ?? 5171)
app.listen(PORT, () => {
  console.log(`[bannerforge] API listening on http://localhost:${PORT}`)
})
