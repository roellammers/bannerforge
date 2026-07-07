import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PALETTE, DEFAULT_SIZES } from '../shared/types.js'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DATA_DIR = path.join(ROOT, 'data')
export const ASSETS_DIR = path.join(DATA_DIR, 'assets')
export const BACKGROUNDS_DIR = path.join(ASSETS_DIR, 'backgrounds')

for (const dir of [DATA_DIR, ASSETS_DIR, BACKGROUNDS_DIR]) {
  fs.mkdirSync(dir, { recursive: true })
}

export const db = new Database(path.join(DATA_DIR, 'app.db'))
// TRUNCATE instead of WAL: the repo may live in an iCloud/Drive-synced folder,
// and sync services can corrupt a database whose -wal/-shm side files are
// snapshotted out of step. Write volume here is tiny, so WAL buys nothing.
db.pragma('journal_mode = TRUNCATE')

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sizes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  UNIQUE(width, height)
);
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creative TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  background_path TEXT NOT NULL,
  bg_width INTEGER NOT NULL DEFAULT 0,
  bg_height INTEGER NOT NULL DEFAULT 0,
  config TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(creative, width, height)
);
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  display_override TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS run_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  template_id INTEGER NOT NULL REFERENCES templates(id),
  config_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  file_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- One row per (company, template): the last successful generation, used for
-- skip-unchanged. Upserted on each successful write.
CREATE UNIQUE INDEX IF NOT EXISTS idx_run_history_pair ON run_history(company_id, template_id);
`)

const insertSize = db.prepare('INSERT OR IGNORE INTO sizes (width, height) VALUES (?, ?)')
for (const [w, h] of DEFAULT_SIZES) insertSize.run(w, h)

export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value)
}

// Seed defaults on first boot
if (getSetting('output_dir') === null) setSetting('output_dir', path.join(ROOT, 'output'))
if (getSetting('palette') === null) setSetting('palette', JSON.stringify(DEFAULT_PALETTE))
if (getSetting('monthly_limit') === null) setSetting('monthly_limit', '500')
