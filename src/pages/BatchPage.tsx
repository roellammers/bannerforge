import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppSettings, Company, TemplateRecord } from '../../shared/types'
import { api } from '../api'
import { loadImage } from '../render/engine'
import { displayNameOf, renderJob } from '../render/job'
import { configHash } from '../hash'

type Phase = 'idle' | 'awaitingApproval' | 'running' | 'done'
type CompanyStatus = 'queued' | 'running' | 'done' | 'skipped' | 'failed'

interface CompanyProgress {
  status: CompanyStatus
  written: number
  skipped: number
  failed: number
  flagged: number
}

interface Failure {
  companyId: number
  company: string
  template: TemplateRecord
  displayName: string
  error: string
}

interface Flagged {
  key: string
  companyId: number
  company: string
  template: TemplateRecord
  dataUrl: string
}

interface PreviewItem {
  template: TemplateRecord
  dataUrl: string
  overflow: boolean
}

// One (company, template) file write, shared by run/retry/re-render.
async function writeOne(
  company: Company,
  template: TemplateRecord,
  logo: HTMLImageElement | null,
  canvas: HTMLCanvasElement,
  compress: boolean
): Promise<{ dataUrl: string; overflow: boolean; path: string; compressionError: string | null }> {
  const displayName = displayNameOf(company)
  const job = await renderJob(template, displayName, logo, canvas)
  const form = new FormData()
  form.append('file', job.blob, 'render.png')
  form.append('company', company.name)
  form.append('message', template.creative)
  form.append('width', String(template.width))
  form.append('height', String(template.height))
  form.append('companyId', String(company.id))
  form.append('templateId', String(template.id))
  form.append('configHash', configHash(template.config, displayName))
  if (compress) form.append('compress', '1')
  const res = await api.writeRender(form)
  return { dataUrl: job.dataUrl, overflow: job.overflow, path: res.path, compressionError: res.compressionError }
}

interface CompressionFailure {
  path: string
  company: string
  label: string
  error: string
}

interface TinifyInfo {
  configured: boolean
  compressionCount: number | null
  monthlyLimit: number
}

export default function BatchPage() {
  const [companies, setCompanies] = useState<Company[]>([])
  const [templates, setTemplates] = useState<TemplateRecord[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [skipUnchanged, setSkipUnchanged] = useState(true)
  const [force, setForce] = useState(false)
  const [dryRun, setDryRun] = useState(false)
  const [tinify, setTinify] = useState<TinifyInfo | null>(null)
  const [compressionFailures, setCompressionFailures] = useState<CompressionFailure[]>([])
  const [retryingCompression, setRetryingCompression] = useState(false)

  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState<Record<number, CompanyProgress>>({})
  const [preview, setPreview] = useState<{ company: Company; items: PreviewItem[] } | null>(null)
  const [failures, setFailures] = useState<Failure[]>([])
  const [flagged, setFlagged] = useState<Flagged[]>([])
  const [written, setWritten] = useState(0)
  const [skipped, setSkipped] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)

  const runToken = useRef(0)
  const logoRef = useRef<HTMLImageElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(document.createElement('canvas'))

  const refreshCompanies = () => api.getCompanies().then(setCompanies)
  useEffect(() => {
    api.getCompanies().then((cs) => {
      setCompanies(cs)
      setSelected(new Set(cs.map((c) => c.id)))
    })
    api.getTemplates().then(setTemplates).catch((e) => setError(e.message))
    api.getSettings().then(setSettings).catch(() => {})
    api.tinifyStatus().then((s) => {
      setTinify(s)
      if (!s.configured) setDryRun(true)
    }).catch(() => {})
  }, [])

  const compressing = !dryRun && (tinify?.configured ?? false)

  const selectedCompanies = useMemo(() => companies.filter((c) => selected.has(c.id)), [companies, selected])
  const totalPairs = selectedCompanies.length * templates.length
  const processed = written + skipped + failures.length

  async function ensureLogo(): Promise<HTMLImageElement | null> {
    if (logoRef.current) return logoRef.current
    if (!settings?.logoPath) return null
    logoRef.current = await loadImage(`/assets/${settings.logoPath}`).catch(() => null)
    return logoRef.current
  }

  function resetCounters() {
    setWritten(0)
    setSkipped(0)
    setFailures([])
    setFlagged([])
    setCompressionFailures([])
    setProgress(Object.fromEntries(selectedCompanies.map((c) => [c.id, { status: 'queued', written: 0, skipped: 0, failed: 0, flagged: 0 } as CompanyProgress])))
  }

  // Renders the first selected company (no writes) for the approval gate.
  async function startPreview() {
    if (selectedCompanies.length === 0 || templates.length === 0) return
    setError(null)
    setPhase('running')
    try {
      const logo = await ensureLogo()
      const company = selectedCompanies[0]
      const canvas = canvasRef.current
      const items: PreviewItem[] = []
      for (const template of templates) {
        const job = await renderJob(template, displayNameOf(company), logo, canvas)
        items.push({ template, dataUrl: job.dataUrl, overflow: job.overflow })
      }
      setPreview({ company, items })
      setPhase('awaitingApproval')
    } catch (e) {
      setError((e as Error).message)
      setPhase('idle')
    }
  }

  async function runBatch(list: Company[]) {
    const token = ++runToken.current
    setError(null)
    try {
      const history = await api.getRunHistory()
      const historyMap = new Map(history.map((h) => [`${h.companyId}:${h.templateId}`, h.configHash]))

      // Estimate compressions before starting and warn if the batch would
      // blow past the monthly plan limit.
      if (compressing && tinify) {
        let planned = 0
        for (const company of list) {
          const displayName = displayNameOf(company)
          for (const template of templates) {
            if (skipUnchanged && !force && historyMap.get(`${company.id}:${template.id}`) === configHash(template.config, displayName)) continue
            planned++
          }
        }
        const used = tinify.compressionCount ?? 0
        if (used + planned > tinify.monthlyLimit) {
          const ok = window.confirm(
            `This batch will use ~${planned} Tinify compressions. With ${used} already used this month, that exceeds your plan limit of ${tinify.monthlyLimit}. Continue anyway?`
          )
          if (!ok) return
        }
      }

      setPhase('running')
      resetCounters()
      setPreview(null)
      const logo = await ensureLogo()
      const canvas = canvasRef.current

      for (const company of list) {
        if (runToken.current !== token) return
        setProgress((p) => ({ ...p, [company.id]: { ...p[company.id], status: 'running' } }))
        const displayName = displayNameOf(company)
        let cWritten = 0
        let cSkipped = 0
        let cFailed = 0
        let cFlagged = 0
        for (const template of templates) {
          if (runToken.current !== token) return
          const hash = configHash(template.config, displayName)
          const key = `${company.id}:${template.id}`
          if (skipUnchanged && !force && historyMap.get(key) === hash) {
            cSkipped++
            setSkipped((n) => n + 1)
            continue
          }
          try {
            const { dataUrl, overflow, path, compressionError } = await writeOne(company, template, logo, canvas, compressing)
            cWritten++
            setWritten((n) => n + 1)
            if (compressionError) {
              setCompressionFailures((cf) => [
                ...cf,
                { path, company: company.name, label: `${template.creative} ${template.width}x${template.height}`, error: compressionError },
              ])
            }
            if (overflow) {
              cFlagged++
              setFlagged((f) => [...f, { key, companyId: company.id, company: company.name, template, dataUrl }])
            }
          } catch (e) {
            cFailed++
            setFailures((f) => [...f, { companyId: company.id, company: company.name, template, displayName, error: (e as Error).message }])
          }
        }
        setProgress((p) => ({
          ...p,
          [company.id]: {
            status: cFailed > 0 ? 'failed' : cWritten === 0 && cSkipped > 0 ? 'skipped' : 'done',
            written: cWritten,
            skipped: cSkipped,
            failed: cFailed,
            flagged: cFlagged,
          },
        }))
      }
      if (runToken.current === token) setPhase('done')
    } catch (e) {
      setError((e as Error).message)
      setPhase('done')
    } finally {
      api.tinifyStatus().then(setTinify).catch(() => {})
    }
  }

  function cancel() {
    runToken.current++
    setPhase('idle')
    setPreview(null)
  }

  async function retryFailures() {
    if (failures.length === 0) return
    setRetrying(true)
    const logo = await ensureLogo()
    const canvas = canvasRef.current
    const stillFailing: Failure[] = []
    for (const f of failures) {
      const company = companies.find((c) => c.id === f.companyId)
      if (!company) continue
      try {
        const { overflow, dataUrl } = await writeOne(company, f.template, logo, canvas, compressing)
        setWritten((n) => n + 1)
        if (overflow) {
          setFlagged((fl) => [...fl, { key: `${company.id}:${f.template.id}`, companyId: company.id, company: company.name, template: f.template, dataUrl }])
        }
      } catch (e) {
        stillFailing.push({ ...f, error: (e as Error).message })
      }
    }
    setFailures(stillFailing)
    setRetrying(false)
  }

  // Re-compress written-but-uncompressed files in place.
  async function retryCompressions() {
    if (compressionFailures.length === 0) return
    setRetryingCompression(true)
    const still: CompressionFailure[] = []
    for (const f of compressionFailures) {
      try {
        await api.tinifyCompressFile(f.path)
      } catch (e) {
        still.push({ ...f, error: (e as Error).message })
      }
    }
    setCompressionFailures(still)
    setRetryingCompression(false)
    api.tinifyStatus().then(setTinify).catch(() => {})
  }

  // ---- flagged review queue actions ----

  function acceptFlagged(key: string) {
    setFlagged((f) => f.filter((x) => x.key !== key))
  }

  function skipCompany(companyId: number) {
    setFlagged((f) => f.filter((x) => x.companyId !== companyId))
  }

  async function renameAndRerender(item: Flagged, newDisplay: string) {
    try {
      const updated = await api.setCompanyOverride(item.companyId, newDisplay)
      setCompanies((cs) => cs.map((c) => (c.id === updated.id ? updated : c)))
      const logo = await ensureLogo()
      const { dataUrl, overflow } = await writeOne(updated, item.template, logo, canvasRef.current, compressing)
      if (overflow) {
        setFlagged((f) => f.map((x) => (x.key === item.key ? { ...x, company: updated.name, dataUrl } : x)))
      } else {
        setFlagged((f) => f.filter((x) => x.key !== item.key))
      }
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const running = phase === 'running'
  const byCreative = useMemo(() => {
    const m = new Map<string, PreviewItem[]>()
    for (const it of preview?.items ?? []) {
      const list = m.get(it.template.creative) ?? []
      list.push(it)
      m.set(it.template.creative, list)
    }
    return [...m.entries()]
  }, [preview])

  return (
    <div>
      <h1>Batch generate</h1>
      <p className="muted">
        Dry run: PNGs are written to the output folder; Tinify compression arrives in Phase 4. Regenerating a company
        overwrites its own files — companies not in the run are never touched.
      </p>
      {error && (
        <p className="error">
          {error} <button className="secondary" onClick={() => setError(null)}>Dismiss</button>
        </p>
      )}
      {templates.length === 0 && <p className="muted">No templates yet — upload backgrounds first.</p>}

      {/* ---- setup ---- */}
      {(phase === 'idle' || phase === 'running' || phase === 'done') && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>
              Companies ({selected.size}/{companies.length} selected)
            </h2>
            <div className="row">
              <button className="secondary" disabled={running} onClick={() => setSelected(new Set(companies.map((c) => c.id)))}>
                Select all
              </button>
              <button className="secondary" disabled={running} onClick={() => setSelected(new Set())}>
                Select none
              </button>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 4, marginTop: 8, maxHeight: 200, overflow: 'auto' }}>
            {companies.map((c) => (
              <label key={c.id} className="row" style={{ gap: 6, fontSize: 13, fontWeight: 400 }}>
                <input
                  type="checkbox"
                  checked={selected.has(c.id)}
                  disabled={running}
                  onChange={(e) => {
                    setSelected((prev) => {
                      const next = new Set(prev)
                      if (e.target.checked) next.add(c.id)
                      else next.delete(c.id)
                      return next
                    })
                  }}
                />
                {displayNameOf(c)}
                {c.displayOverride && <span className="muted" style={{ fontSize: 11 }}>(override)</span>}
              </label>
            ))}
            {companies.length === 0 && <span className="muted">No companies — add them on the Companies page.</span>}
          </div>

          <div className="row" style={{ marginTop: 14 }}>
            <label className="row" style={{ gap: 6, fontWeight: 400 }}>
              <input type="checkbox" checked={skipUnchanged} disabled={running} onChange={(e) => setSkipUnchanged(e.target.checked)} />
              Skip unchanged (only regenerate companies/templates changed since last run)
            </label>
          </div>
          <div className="row">
            <label className="row" style={{ gap: 6, fontWeight: 400 }}>
              <input type="checkbox" checked={force} disabled={running || !skipUnchanged} onChange={(e) => setForce(e.target.checked)} />
              Force regenerate everything
            </label>
          </div>
          <div className="row">
            <label className="row" style={{ gap: 6, fontWeight: 400 }}>
              <input
                type="checkbox"
                checked={dryRun}
                disabled={running || !tinify?.configured}
                onChange={(e) => setDryRun(e.target.checked)}
              />
              Dry run — skip Tinify compression (no credits used)
            </label>
            {tinify?.configured ? (
              <span className="muted">
                Tinify credits used this month: {tinify.compressionCount ?? '—'} / {tinify.monthlyLimit}
              </span>
            ) : (
              <span className="badge warn">Tinify not configured (set TINIFY_API_KEY in .env) — dry run forced</span>
            )}
          </div>

          <div className="row" style={{ marginTop: 16 }}>
            <button className="primary" disabled={running || selectedCompanies.length === 0 || templates.length === 0} onClick={() => runBatch(selectedCompanies)}>
              Full run ({totalPairs} ads)
            </button>
            <button className="secondary" disabled={running || selectedCompanies.length === 0 || templates.length === 0} onClick={startPreview}>
              Preview run (first company, then approve)
            </button>
            {running && <button className="danger" onClick={cancel}>Cancel</button>}
          </div>
        </div>
      )}

      {/* ---- preview-run approval gate ---- */}
      {phase === 'awaitingApproval' && preview && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>Preview — {displayNameOf(preview.company)} ({preview.items.length} ads)</h2>
            <div className="row">
              <button className="primary" onClick={() => runBatch(selectedCompanies)}>
                Approve and start batch ({selectedCompanies.length} companies)
              </button>
              <button className="secondary" onClick={cancel}>Cancel</button>
            </div>
          </div>
          <p className="muted">Review the first company below. Approving generates the whole batch automatically.</p>
          {byCreative.map(([creative, items]) => (
            <div key={creative} style={{ marginBottom: 12 }}>
              <strong>{creative}</strong>
              <div className="row" style={{ alignItems: 'flex-start', marginTop: 6 }}>
                {items.map((it) => (
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

      {/* ---- progress ---- */}
      {(phase === 'running' || phase === 'done') && Object.keys(progress).length > 0 && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong>
              {phase === 'done' ? 'Batch complete' : 'Generating…'} — {processed}/{totalPairs} ads
            </strong>
            <span className="muted">{written} written · {skipped} skipped · {failures.length} failed{flagged.length > 0 ? ` · ${flagged.length} flagged` : ''}</span>
          </div>
          <div style={{ height: 8, background: 'var(--border)', borderRadius: 99, overflow: 'hidden', margin: '10px 0' }}>
            <div style={{ height: '100%', width: `${totalPairs ? (processed / totalPairs) * 100 : 0}%`, background: 'var(--dark-green)', transition: 'width 0.2s' }} />
          </div>
          <table className="gen-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Status</th>
                <th>Written</th>
                <th>Skipped</th>
                <th>Failed</th>
                <th>Flagged</th>
              </tr>
            </thead>
            <tbody>
              {selectedCompanies.map((c) => {
                const pr = progress[c.id]
                if (!pr) return null
                return (
                  <tr key={c.id}>
                    <td>{displayNameOf(c)}</td>
                    <td>
                      {pr.status === 'done' && <span className="status-ok">Done</span>}
                      {pr.status === 'skipped' && <span className="muted">Unchanged</span>}
                      {pr.status === 'failed' && <span className="status-err">Failed</span>}
                      {pr.status === 'running' && 'Rendering…'}
                      {pr.status === 'queued' && <span className="muted">Queued</span>}
                    </td>
                    <td>{pr.written}</td>
                    <td>{pr.skipped}</td>
                    <td>{pr.failed}</td>
                    <td>{pr.flagged > 0 ? <span className="badge warn">{pr.flagged}</span> : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ---- summary ---- */}
      {phase === 'done' && (
        <div className="card" style={{ marginTop: 14 }}>
          <h2 style={{ marginTop: 0 }}>Summary</h2>
          <p>
            <strong>{written}</strong> files written · <strong>{skipped}</strong> skipped (unchanged) ·{' '}
            <strong>{failures.length}</strong> failed · <strong>{flagged.length}</strong> flagged for review
          </p>
          {compressing ? (
            <p className="muted">
              Compressed via Tinify ({compressionFailures.length > 0 ? `${compressionFailures.length} compression failures — written uncompressed` : 'all files'}).
              Credits used this month: <strong>{tinify?.compressionCount ?? '—'}</strong> / {tinify?.monthlyLimit}.
            </p>
          ) : (
            <p className="muted">Compression: skipped (dry run) — no Tinify credits used.</p>
          )}
          <div className="row">
            <code className="path">{settings?.outputDir}</code>
            <button className="secondary" onClick={() => api.openFolder().catch((e) => setError(e.message))}>
              Open output folder
            </button>
            <button className="secondary" onClick={() => { setPhase('idle'); refreshCompanies() }}>
              New batch
            </button>
          </div>

          {compressionFailures.length > 0 && (
            <>
              <h2>Compression failures ({compressionFailures.length})</h2>
              <p className="muted">These files were written uncompressed. Retry re-compresses them in place.</p>
              <button className="primary" disabled={retryingCompression} onClick={retryCompressions}>
                {retryingCompression ? 'Compressing…' : 'Retry failed compressions'}
              </button>
              <table className="gen-table">
                <tbody>
                  {compressionFailures.map((f, i) => (
                    <tr key={i}>
                      <td>{f.company}</td>
                      <td>{f.label}</td>
                      <td className="status-err">{f.error}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {failures.length > 0 && (
            <>
              <h2>Failures ({failures.length})</h2>
              <button className="primary" disabled={retrying} onClick={retryFailures}>
                {retrying ? 'Retrying…' : 'Retry failed'}
              </button>
              <table className="gen-table">
                <tbody>
                  {failures.map((f, i) => (
                    <tr key={i}>
                      <td>{f.company}</td>
                      <td>{f.template.creative} {f.template.width}x{f.template.height}</td>
                      <td className="status-err">{f.error}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}

      {/* ---- flagged-cases review queue ---- */}
      {phase === 'done' && flagged.length > 0 && (
        <div className="card" style={{ marginTop: 14 }}>
          <h2 style={{ marginTop: 0 }}>Review queue — {flagged.length} flagged (headline overflow at floor)</h2>
          <p className="muted">
            These were written anyway. Fix a display name to re-render immediately, accept as-is, or skip the company.
          </p>
          {flagged.map((item) => (
            <FlaggedRow
              key={item.key}
              item={item}
              currentDisplay={displayNameOf(companies.find((c) => c.id === item.companyId) ?? { name: item.company, displayOverride: null })}
              onAccept={() => acceptFlagged(item.key)}
              onSkip={() => skipCompany(item.companyId)}
              onRename={(name) => renameAndRerender(item, name)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function FlaggedRow(props: {
  item: Flagged
  currentDisplay: string
  onAccept: () => void
  onSkip: () => void
  onRename: (name: string) => Promise<void>
}) {
  const { item, currentDisplay, onAccept, onSkip, onRename } = props
  const [name, setName] = useState(currentDisplay)
  const [busy, setBusy] = useState(false)
  return (
    <div className="row" style={{ alignItems: 'flex-start', borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 12 }}>
      <img
        src={item.dataUrl}
        alt=""
        style={{ width: Math.min(item.template.width, 300), border: '1px solid var(--border)', borderRadius: 4 }}
      />
      <div style={{ flex: 1, minWidth: 240 }}>
        <strong>{item.company}</strong>{' '}
        <span className="muted">{item.template.creative} · {item.template.width}x{item.template.height}</span>
        <label className="field" style={{ marginTop: 8 }}>
          Display name on ad
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="row" style={{ marginTop: 8 }}>
          <button
            className="primary"
            disabled={busy || !name.trim()}
            onClick={async () => {
              setBusy(true)
              await onRename(name.trim())
              setBusy(false)
            }}
          >
            {busy ? 'Re-rendering…' : 'Save & re-render'}
          </button>
          <button className="secondary" onClick={onAccept}>Accept as-is</button>
          <button className="danger" onClick={onSkip}>Skip company</button>
        </div>
      </div>
    </div>
  )
}
