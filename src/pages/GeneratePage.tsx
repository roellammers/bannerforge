import { useEffect, useRef, useState } from 'react'
import type { AppSettings, Company, TemplateRecord } from '../../shared/types'
import { api } from '../api'
import { canvasToPngBlob, loadImage, renderTemplate } from '../render/engine'
import { configFontWeights, ensureFonts } from '../render/fonts'

interface ItemStatus {
  template: TemplateRecord
  status: 'pending' | 'rendering' | 'written' | 'error'
  path?: string
  error?: string
  flagged?: boolean // headline overflowed at the shrink floor
}

export default function GeneratePage() {
  const [companies, setCompanies] = useState<Company[]>([])
  const [templates, setTemplates] = useState<TemplateRecord[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [company, setCompany] = useState('')
  const [items, setItems] = useState<ItemStatus[]>([])
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dryRun, setDryRun] = useState(false)
  const [tinify, setTinify] = useState<{ configured: boolean; compressionCount: number | null; monthlyLimit: number } | null>(null)
  const runToken = useRef(0)

  useEffect(() => {
    api.getCompanies().then(setCompanies).catch(() => {})
    api.getTemplates().then(setTemplates).catch((e) => setError(e.message))
    api.getSettings().then(setSettings).catch(() => {})
    api.tinifyStatus().then((s) => {
      setTinify(s)
      if (!s.configured) setDryRun(true)
    }).catch(() => {})
  }, [])

  const compressing = !dryRun && (tinify?.configured ?? false)

  async function generate() {
    const name = company.trim()
    if (!name || templates.length === 0 || running) return
    const token = ++runToken.current
    setRunning(true)
    setError(null)
    setItems(templates.map((template) => ({ template, status: 'pending' })))
    try {
      // Persist the company (and pick up any saved display-name override).
      const record = await api.addCompany(name)
      api.getCompanies().then(setCompanies).catch(() => {})
      // Rendered text uses the override; file/folder names use the original.
      const originalName = record.name
      const displayName = record.displayOverride?.trim() || record.name

      const logoImg = settings?.logoPath ? await loadImage(`/assets/${settings.logoPath}`).catch(() => null) : null
      const canvas = document.createElement('canvas')

      for (let i = 0; i < templates.length; i++) {
        if (runToken.current !== token) return
        const template = templates[i]
        setItems((prev) => prev.map((it, j) => (j === i ? { ...it, status: 'rendering' } : it)))
        try {
          await ensureFonts(configFontWeights(template.config))
          const background = await loadImage(`/assets/${template.backgroundPath}`)
          const metrics = renderTemplate({
            config: template.config,
            width: template.width,
            height: template.height,
            company: displayName,
            background,
            logo: logoImg,
            target: canvas,
          })
          const blob = await canvasToPngBlob(canvas)
          const form = new FormData()
          form.append('file', blob, 'render.png')
          form.append('company', originalName)
          form.append('message', template.creative)
          form.append('width', String(template.width))
          form.append('height', String(template.height))
          if (compressing) form.append('compress', '1')
          const res = await api.writeRender(form)
          if (res.compressionError) setError(`Compression failed (written uncompressed): ${res.compressionError}`)
          setItems((prev) =>
            prev.map((it, j) => (j === i ? { ...it, status: 'written', path: res.path, flagged: metrics.headlineOverflow } : it))
          )
        } catch (e) {
          setItems((prev) => prev.map((it, j) => (j === i ? { ...it, status: 'error', error: (e as Error).message } : it)))
        }
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      if (runToken.current === token) setRunning(false)
    }
  }

  const written = items.filter((i) => i.status === 'written').length
  const failed = items.filter((i) => i.status === 'error').length
  const flagged = items.filter((i) => i.flagged).length
  const done = !running && items.length > 0

  return (
    <div>
      <h1>Generate — single company</h1>
      <div className="row" style={{ marginBottom: 10 }}>
        <label className="row" style={{ gap: 6, fontWeight: 400 }}>
          <input type="checkbox" checked={dryRun} disabled={running || !tinify?.configured} onChange={(e) => setDryRun(e.target.checked)} />
          Dry run — skip Tinify compression
        </label>
        {tinify?.configured ? (
          <span className="muted">Credits used this month: {tinify.compressionCount ?? '—'} / {tinify.monthlyLimit}</span>
        ) : (
          <span className="badge warn">Tinify not configured — dry run forced</span>
        )}
      </div>
      {error && <p className="error">{error}</p>}

      <div className="card row">
        <label className="field" style={{ minWidth: 280 }}>
          Company
          <input
            list="company-list"
            value={company}
            placeholder="Type or pick a company…"
            onChange={(e) => setCompany(e.target.value)}
          />
        </label>
        <datalist id="company-list">
          {companies.map((c) => (
            <option key={c.id} value={c.name} />
          ))}
        </datalist>
        <button className="primary" disabled={!company.trim() || templates.length === 0 || running} onClick={generate}>
          {running ? `Generating… (${written + failed}/${items.length})` : `Generate ${templates.length} ads`}
        </button>
        {templates.length === 0 && <span className="muted">No templates yet — upload backgrounds first.</span>}
      </div>

      {items.length > 0 && (
        <>
          {done && (
            <div className="card row" style={{ marginTop: 14 }}>
              <strong>
                {written}/{items.length} files written{failed > 0 ? `, ${failed} failed` : ''}
              </strong>
              {flagged > 0 && <span className="badge warn">{flagged} flagged (headline overflow)</span>}
              <code className="path">{settings?.outputDir}</code>
              <button className="secondary" onClick={() => api.openFolder().catch((e) => setError(e.message))}>
                Open output folder
              </button>
            </div>
          )}
          <table className="gen-table">
            <thead>
              <tr>
                <th>Creative</th>
                <th>Size</th>
                <th>Status</th>
                <th>File</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i}>
                  <td>{it.template.creative}</td>
                  <td>
                    {it.template.width}x{it.template.height}
                  </td>
                  <td>
                    {it.status === 'written' && <span className="status-ok">Written</span>}
                    {it.status === 'written' && it.flagged && (
                      <span className="badge warn" style={{ marginLeft: 6 }}>overflow</span>
                    )}
                    {it.status === 'error' && <span className="status-err">{it.error}</span>}
                    {it.status === 'rendering' && 'Rendering…'}
                    {it.status === 'pending' && <span className="muted">Queued</span>}
                  </td>
                  <td>{it.path && <code className="path">{it.path}</code>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}
