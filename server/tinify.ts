// Tinify (TinyPNG) proxy. The API key stays server-side in .env; the browser
// never talks to Tinify. Calls are throttled with a minimum interval and
// retried with exponential backoff (3 attempts per file). The monthly
// compression count is read from every response header and persisted so the
// UI can show credits used and warn before a batch.
import { getSetting, setSetting } from './db.js'

const API_URL = 'https://api.tinify.com/shrink'
const MIN_INTERVAL_MS = 500
const MAX_ATTEMPTS = 3

function apiKey(): string | null {
  const key = process.env.TINIFY_API_KEY?.trim()
  return key ? key : null
}

export function isConfigured(): boolean {
  return apiKey() !== null
}

export interface TinifyStatus {
  configured: boolean
  compressionCount: number | null // this month, per Tinify's own counter
  countUpdatedAt: string | null
}

export function tinifyStatus(): TinifyStatus {
  const raw = getSetting('tinify_count')
  return {
    configured: isConfigured(),
    compressionCount: raw !== null ? Number(raw) : null,
    countUpdatedAt: getSetting('tinify_count_at'),
  }
}

function recordCount(count: number): void {
  setSetting('tinify_count', String(count))
  setSetting('tinify_count_at', new Date().toISOString())
}

let lastCallAt = 0

async function throttle(): Promise<void> {
  const now = Date.now()
  const wait = Math.max(0, lastCallAt + MIN_INTERVAL_MS - now)
  lastCallAt = now + wait
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
}

class FatalTinifyError extends Error {}

async function attemptCompress(buf: Buffer, auth: string): Promise<Buffer> {
  await throttle()
  const res = await fetch(API_URL, { method: 'POST', headers: { Authorization: auth }, body: new Uint8Array(buf) })
  const countHeader = res.headers.get('compression-count')
  if (countHeader && Number.isFinite(Number(countHeader))) recordCount(Number(countHeader))
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string }
    const msg = body.message || `Tinify responded ${res.status}`
    // Bad key or monthly limit exhausted: retrying can't help.
    if (res.status === 401 || res.status === 429) throw new FatalTinifyError(msg)
    throw new Error(msg)
  }
  const json = (await res.json()) as { output?: { url?: string } }
  if (!json.output?.url) throw new Error('Tinify response missing output URL')
  const dl = await fetch(json.output.url, { headers: { Authorization: auth } })
  if (!dl.ok) throw new Error(`Compressed download failed (${dl.status})`)
  return Buffer.from(await dl.arrayBuffer())
}

export async function compressPng(buf: Buffer): Promise<Buffer> {
  const key = apiKey()
  if (!key) throw new Error('TINIFY_API_KEY is not set in .env')
  const auth = 'Basic ' + Buffer.from(`api:${key}`).toString('base64')
  let lastError: Error = new Error('Tinify compression failed')
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await attemptCompress(buf, auth)
    } catch (e) {
      lastError = e as Error
      if (e instanceof FatalTinifyError) break
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)))
      }
    }
  }
  throw lastError
}
