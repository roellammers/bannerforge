import { useEffect, useState } from 'react'
import type { AppSettings, BannerSize, Palette } from '../../shared/types'
import { api } from '../api'

const PALETTE_LABELS: Record<keyof Palette, string> = {
  mainGreen: 'Main Green',
  marigold: 'Marigold',
  darkGreen: 'Dark Green',
  brightSnow: 'Bright Snow',
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tinify, setTinify] = useState<{ configured: boolean; compressionCount: number | null; countUpdatedAt: string | null } | null>(null)
  const [sizes, setSizes] = useState<BannerSize[]>([])
  const [newSize, setNewSize] = useState({ width: '', height: '' })

  useEffect(() => {
    api.getSettings().then(setSettings).catch((e) => setError(e.message))
    api.tinifyStatus().then(setTinify).catch(() => {})
    api.getSizes().then(setSizes).catch(() => {})
  }, [])

  async function addSize() {
    const w = Number(newSize.width)
    const h = Number(newSize.height)
    if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return
    try {
      setSizes(await api.addSize(w, h))
      setNewSize({ width: '', height: '' })
    } catch (e) {
      setError((e as Error).message)
    }
  }

  if (error) return <p className="error">{error}</p>
  if (!settings) return <p className="muted">Loading…</p>

  async function save() {
    if (!settings) return
    setError(null)
    try {
      setSettings(await api.saveSettings(settings))
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <h1>Settings</h1>

      <div className="card">
        <label className="field">
          Output folder (point this at a Google Drive synced folder)
          <input
            value={settings.outputDir}
            onChange={(e) => setSettings({ ...settings, outputDir: e.target.value })}
          />
        </label>
        <p className="muted">
          Files land in <code>{'{output}/{Company}/{Company}_{Message}_{WxH}.png'}</code>. No ZIPs, ever.
        </p>

        <h2>Brand palette</h2>
        <p className="muted">New templates prefill from these; each element's color stays editable per template.</p>
        <div className="controls-grid">
          {(Object.keys(PALETTE_LABELS) as Array<keyof Palette>).map((key) => (
            <label className="field" key={key}>
              {PALETTE_LABELS[key]}
              <div className="row" style={{ gap: 8 }}>
                <input
                  type="color"
                  value={settings.palette[key]}
                  style={{ padding: 2, width: 44, height: 30 }}
                  onChange={(e) => setSettings({ ...settings, palette: { ...settings.palette, [key]: e.target.value } })}
                />
                <input
                  value={settings.palette[key]}
                  style={{ width: 90 }}
                  onChange={(e) => setSettings({ ...settings, palette: { ...settings.palette, [key]: e.target.value } })}
                />
              </div>
            </label>
          ))}
        </div>

        <h2>Banner sizes</h2>
        <p className="muted">
          Sizes feed the upload dropdown — a new format is a row here, not a code change. Backgrounds must be exported at
          2x these dimensions. Removing a size doesn't touch existing templates.
        </p>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          {sizes.map((s) => (
            <span key={s.id} className="badge ok" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {s.width}x{s.height}
              <button
                type="button"
                title={`Remove ${s.width}x${s.height}`}
                style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'inherit', fontWeight: 700, padding: 0 }}
                onClick={() => api.deleteSize(s.id).then(setSizes).catch((e) => setError(e.message))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <label className="field" style={{ width: 100 }}>
            Width
            <input type="number" min={1} value={newSize.width} onChange={(e) => setNewSize({ ...newSize, width: e.target.value })} />
          </label>
          <label className="field" style={{ width: 100 }}>
            Height
            <input type="number" min={1} value={newSize.height} onChange={(e) => setNewSize({ ...newSize, height: e.target.value })} />
          </label>
          <button className="secondary" disabled={!newSize.width || !newSize.height} onClick={addSize} style={{ alignSelf: 'flex-end' }}>
            Add size
          </button>
        </div>

        <h2>Tinify</h2>
        {tinify && (
          <p style={{ marginTop: 0 }}>
            {tinify.configured ? (
              <>
                <span className="status-ok">Configured</span> · credits used this month:{' '}
                <strong>{tinify.compressionCount ?? 'unknown (updates after the first compression)'}</strong>
                {tinify.countUpdatedAt && (
                  <span className="muted"> (as of {new Date(tinify.countUpdatedAt).toLocaleString()})</span>
                )}
              </>
            ) : (
              <span className="badge warn">Not configured — set TINIFY_API_KEY in .env and restart the app</span>
            )}
          </p>
        )}
        <label className="field" style={{ maxWidth: 220 }}>
          Monthly compression limit
          <input
            type="number"
            min={1}
            value={settings.monthlyLimit}
            onChange={(e) => setSettings({ ...settings, monthlyLimit: Number(e.target.value) })}
          />
        </label>
        <p className="muted">
          Batches warn before starting if they would exceed this limit. The API key lives in <code>.env</code> (TINIFY_API_KEY), never in the frontend.
        </p>

        <div className="row" style={{ marginTop: 16 }}>
          <button className="primary" onClick={save}>
            Save settings
          </button>
          {saved && <span className="status-ok">Saved</span>}
        </div>
      </div>
    </div>
  )
}
