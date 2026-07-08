import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppSettings, Company, TemplateRecord } from '../../shared/types'
import { api } from '../api'
import { loadImage } from '../render/engine'
import { displayNameOf, renderJob } from '../render/job'
import { renderHash } from '../hash'

type Phase = 'idle' | 'rendering' | 'review' | 'writing' | 'done'

interface RenderedItem {
  template: TemplateRecord
  blob: Blob
  dataUrl: string
  overflow: boolean
  status: 'rendered' | 'writing' | 'written' | 'error'
  path?: string
  error?: string
}

export default function GeneratePage() {
  const [companies, setCompanies] = useState<Company[]>([])
  const [templates, setTemplates] = useState<TemplateRecord[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [company, setCompany] = useState('')
  const [companyRecord, setCompanyRecord] = useState<Company | null>(null)
  const [items, setItems] = useState<RenderedItem[]>([])
  const [phase, setPhase] = useState<Phase>('idle')
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
  const busy = phase === 'rendering' || phase === 'writing'

  // Render everything up front — nothing touches disk until approval.
  async function renderAll() {
    const name = company.trim()
    if (!name || templates.length === 0 || busy) return
    const token = ++runToken.current
    setPhase('rendering')
    setError(null)
    setItems([])
    try {
      const record = await api.addCompany(name)
      setCompanyRecord(record)
      api.getCompanies().then(setCompanies).catch(() => {})
      const displayName = displayNameOf(record)
      const logo = settings?.logoPath ? await loadImage(`/assets/${settings.logoPath}`).catch(() => null) : null
      const canvas = document.createElement('canvas')
      const rendered: RenderedItem[] = []
      for (const template of templates) {
        if (runToken.current !== token) return
        const job = await renderJob(template, displayName, logo, canvas)
        rendered.push({ template, blob: job.blob, dataUrl: job.dataUrl, overflow: job.overflow, status: 'rendered' })
        setItems([...rendered])
      }
      setPhase('review')
    } catch (e) {
      setError((e as Error).message)
      setPhase('idle')
    }
  }

  async function approveAndWrite() {
    if (!companyRecord || items.length === 0) return
    const token = ++runToken.current
    setPhase('writing')
    const displayName = displayNameOf(companyRecord)
    for (let i = 0; i < items.length; i++) {
      if (runToken.current !== token) return
      const it = items[i]
      setItems((prev) => prev.map((x, j) => (j === i ? { ...x, status: 'writing' } : x)))
      try {
        const form = new FormData()
        form.append('file', it.blob, 'render.png')
        form.append('company', companyRecord.name)
        form.append('message', it.template.creative)
        form.append('width', String(it.template.width))
        form.append('height', String(it.template.height))
        form.append('companyId', String(companyRecord.id))
        form.append('templateId', String(it.template.id))
        form.append('configHash', renderHash(it.template, displayName, settings?.logoPath ?? null))
        if (compressing) form.append('compress', '1')
        const res = await api.writeRender(form)
        if (res.compressionError) setError(`Compression failed (written uncompressed): ${res.compressionError}`)
        setItems((prev) => prev.map((x, j) => (j === i ? { ...x, status: 'written', path: res.path } : x)))
      } catch (e) {
        setItems((prev) => prev.map((x, j) => (j === i ? { ...x, status: 'error', error: (e as Error).message } : x)))
      }
    }
    setPhase('done')
    api.tinifyStatus().then(setTinify).catch(() => {})
  }

  function cancel() {
    runToken.current++
    setItems([])
    setCompanyRecord(null)
    setPhase('idle')
  }

  const written = items.filter((i) => i.status === 'written').length
  const failed = items.filter((i) => i.status === 'error').length
  const flagged = items.filter((i) => i.overflow).length

  const byCreative = useMemo(() => {
    const m = new Map<string, RenderedItem[]>()
    for (const it of items) {
      const list = m.get(it.template.creative) ?? []
      list.push(it)
      m.set(it.template.creative, list)
    }
    return [...m.entries()]
  }, [items])

  return (
    <div>
      <h1>Generate — single company</h1>
      <div className="row" style={{ marginBottom: 10 }}>
        <label className="row" style={{ gap: 6, fontWeight: 400 }}>
          <input type="checkbox" checked={dryRun} disabled={busy || !tinify?.configured} onChange={(e) => setDryRun(e.target.checked)} />
          Dry run — skip Tinify compression
        </label>
        {tinify?.configured ? (
          <span className="muted">Credits used this month: {tinify.compressionCount ?? '—'} / {tinify.monthlyLimit}</span>
        ) : (
          <span className="badge warn">Tinify not configured — dry run forced</span>
        )}
      </div>
      {error && (
        <p className="error">
          {error} <button className="secondary" onClick={() => setError(null)}>Dismiss</button>
        </p>
      )}

      <div className="card row">
        <label className="field" style={{ minWidth: 280 }}>
          Company
          <input
            list="company-list"
            value={company}
            placeholder="Type or pick a company…"
            disabled={busy || phase === 'review'}
            onChange={(e) => setCompany(e.target.value)}
          />
        </label>
        <datalist id="company-list">
          {companies.map((c) => (
            <option key={c.id} value={c.name} />
          ))}
        </datalist>
        {phase !== 'review' && (
          <button className="primary" disabled={!company.trim() || templates.length === 0 || busy} onClick={renderAll}>
            {phase === 'rendering' ? `Rendering… (${items.length}/${templates.length})` : `Render ${templates.length} ads for review`}
          </button>
        )}
        {(phase === 'review' || phase === 'done') && (
          <button className="secondary" onClick={cancel}>
            {phase === 'done' ? 'New run' : 'Cancel'}
          </button>
        )}
        {templates.length === 0 && <span className="muted">No templates yet — upload backgrounds first.</span>}
      </div>

      {phase === 'review' && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>
              Review — {companyRecord ? displayNameOf(companyRecord) : company} ({items.length} ads)
              {flagged > 0 && <span className="badge warn" style={{ marginLeft: 8 }}>{flagged} overflow</span>}
            </h2>
            <button className="primary" onClick={approveAndWrite}>
              Approve and write {items.length} files
            </button>
          </div>
          <p className="muted">Nothing is on disk yet. Approve to write{compressing ? ' (compressed via Tinify)' : ' (dry run, uncompressed)'}.</p>
          {byCreative.map(([creative, list]) => (
            <div key={creative} style={{ marginBottom: 12 }}>
              <strong>{creative}</strong>
              <div className="row" style={{ alignItems: 'flex-start', marginTop: 6 }}>
                {list.map((it) => (
                  <div key={it.template.id} style={{ textAlign: 'center' }}>
                    <img
                      src={it.dataUrl}
                      alt={`${creative} ${it.template.width}x${it.template.height}`}
                      style={{ width: it.template.width, height: it.template.height, border: '1px solid var(--border)', borderRadius: 4 }}
                    />
                    <div className="muted" style={{ fontSize: 11 }}>
                      {it.template.width}x{it.template.height} {it.overflow && <span className="error">overflow</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {(phase === 'writing' || phase === 'done') && (
        <>
          {phase === 'done' && (
            <div className="card row" style={{ marginTop: 14 }}>
              <strong>
                {written}/{items.length} files written{failed > 0 ? `, ${failed} failed` : ''}
              </strong>
              {flagged > 0 && <span className="badge warn">{flagged} flagged (headline overflow)</span>}
              {compressing && <span className="muted">Credits used this month: {tinify?.compressionCount ?? '—'} / {tinify?.monthlyLimit}</span>}
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
                    {it.status === 'written' && it.overflow && <span className="badge warn" style={{ marginLeft: 6 }}>overflow</span>}
                    {it.status === 'error' && <span className="status-err">{it.error}</span>}
                    {it.status === 'writing' && 'Writing…'}
                    {it.status === 'rendered' && <span className="muted">Queued</span>}
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
