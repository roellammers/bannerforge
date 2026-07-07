import { useEffect, useRef, useState } from 'react'
import type { AppSettings, BannerSize, TemplateRecord } from '../../shared/types'
import { api } from '../api'

// Filename convention: Brand_Message_WxH.png, e.g.
// Pingwire_Faster_case_handling_300x250.png (file itself is a 2x export).
export function parseBackgroundFilename(filename: string): { creative: string; width: number; height: number } | null {
  const m = filename.match(/^(.+)_(\d+)x(\d+)(?:@2x)?\.png$/i)
  if (!m) return null
  let creative = m[1]
  const segments = creative.split('_')
  if (segments.length > 1) creative = segments.slice(1).join('_') // drop leading brand segment
  return { creative, width: Number(m[2]), height: Number(m[3]) }
}

interface PendingUpload {
  key: string
  file: File
  url: string
  creative: string
  width: number
  height: number
  imgWidth: number
  imgHeight: number
  parsed: boolean
  saving: boolean
  error: string | null
}

function is2x(p: PendingUpload): boolean {
  return p.imgWidth === p.width * 2 && p.imgHeight === p.height * 2
}

export default function TemplatesPage({ onEdit }: { onEdit: (id: number) => void }) {
  const [templates, setTemplates] = useState<TemplateRecord[]>([])
  const [sizes, setSizes] = useState<BannerSize[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [pending, setPending] = useState<PendingUpload[]>([])
  const [dragover, setDragover] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [dup, setDup] = useState<{ source: string; target: string; pattern: string; stat: string; sub: string } | null>(null)
  const [dupBusy, setDupBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const logoInput = useRef<HTMLInputElement>(null)

  const refresh = () => {
    api.getTemplates().then(setTemplates).catch((e) => setNotice(String(e.message)))
    api.getSettings().then(setSettings).catch(() => {})
  }

  useEffect(() => {
    refresh()
    api.getSizes().then(setSizes).catch(() => {})
  }, [])

  async function addFiles(files: FileList | File[]) {
    const additions: PendingUpload[] = []
    for (const file of Array.from(files)) {
      if (!file.name.toLowerCase().endsWith('.png')) {
        setNotice(`Skipped ${file.name}: backgrounds must be PNG files`)
        continue
      }
      const url = URL.createObjectURL(file)
      const dims = await new Promise<{ w: number; h: number }>((resolve) => {
        const img = new Image()
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
        img.onerror = () => resolve({ w: 0, h: 0 })
        img.src = url
      })
      const parsed = parseBackgroundFilename(file.name)
      additions.push({
        key: `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`,
        file,
        url,
        creative: parsed?.creative ?? file.name.replace(/\.png$/i, ''),
        width: parsed?.width ?? Math.round(dims.w / 2),
        height: parsed?.height ?? Math.round(dims.h / 2),
        imgWidth: dims.w,
        imgHeight: dims.h,
        parsed: parsed !== null,
        saving: false,
        error: null,
      })
    }
    setPending((prev) => [...prev, ...additions])
  }

  function updatePending(key: string, patch: Partial<PendingUpload>) {
    setPending((prev) => prev.map((p) => (p.key === key ? { ...p, ...patch } : p)))
  }

  async function savePending(p: PendingUpload, replace = false) {
    updatePending(p.key, { saving: true, error: null })
    const form = new FormData()
    form.append('file', p.file)
    form.append('creative', p.creative)
    form.append('width', String(p.width))
    form.append('height', String(p.height))
    if (replace) form.append('replace', '1')
    try {
      await api.uploadTemplate(form)
      URL.revokeObjectURL(p.url)
      setPending((prev) => prev.filter((x) => x.key !== p.key))
      refresh()
    } catch (e) {
      const err = e as Error & { status?: number }
      if (err.status === 409) {
        if (window.confirm(`A template "${p.creative}" at ${p.width}x${p.height} already exists. Replace its background (layout is kept)?`)) {
          await savePending(p, true)
          return
        }
        updatePending(p.key, { saving: false })
      } else {
        updatePending(p.key, { saving: false, error: err.message })
      }
    }
  }

  async function submitDuplicate() {
    if (!dup || !dup.target.trim()) return
    setDupBusy(true)
    try {
      await api.duplicateCreative({
        source: dup.source,
        target: dup.target.trim(),
        headlinePattern: dup.pattern,
        statText: dup.stat,
        subText: dup.sub,
      })
      setDup(null)
      refresh()
    } catch (e) {
      setNotice((e as Error).message)
    } finally {
      setDupBusy(false)
    }
  }

  async function renameCreative(from: string) {
    const to = window.prompt(`Rename creative "${from}" to:`, from)?.trim()
    if (!to || to === from) return
    try {
      await api.renameCreative(from, to)
      refresh()
    } catch (e) {
      setNotice((e as Error).message)
    }
  }

  async function uploadLogo(file: File) {
    const form = new FormData()
    form.append('file', file)
    try {
      await api.uploadLogo(form)
      refresh()
    } catch (e) {
      setNotice((e as Error).message)
    }
  }

  const byCreative = new Map<string, TemplateRecord[]>()
  for (const t of templates) {
    const list = byCreative.get(t.creative) ?? []
    list.push(t)
    byCreative.set(t.creative, list)
  }

  return (
    <div>
      <h1>Templates</h1>
      {notice && (
        <p className="error">
          {notice} <button className="secondary" onClick={() => setNotice(null)}>Dismiss</button>
        </p>
      )}

      <div
        className={`dropzone ${dragover ? 'dragover' : ''}`}
        onClick={() => fileInput.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setDragover(true)
        }}
        onDragLeave={() => setDragover(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragover(false)
          addFiles(e.dataTransfer.files)
        }}
      >
        <strong>Drop background PNGs here</strong> or click to browse.
        <br />
        <span className="muted">
          Naming: <code>Brand_Message_WxH.png</code> at 2x pixels — e.g. <code>Pingwire_Faster_case_handling_300x250.png</code> as a 600x500 export.
        </span>
        <input
          ref={fileInput}
          type="file"
          accept=".png"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files)
            e.target.value = ''
          }}
        />
      </div>

      {pending.length > 0 && (
        <>
          <h2>Ready to save — check the parsed fields</h2>
          <div className="pending-grid">
            {pending.map((p) => (
              <div className="card pending-card" key={p.key}>
                <img src={p.url} alt={p.file.name} />
                <p className="muted" style={{ fontSize: 12, margin: '8px 0 4px' }}>{p.file.name}</p>
                {!p.parsed && <p className="badge warn">Filename didn't match convention — check fields</p>}
                <div className="row" style={{ marginTop: 8 }}>
                  <label className="field" style={{ flex: 1 }}>
                    Creative (message)
                    <input value={p.creative} onChange={(e) => updatePending(p.key, { creative: e.target.value })} />
                  </label>
                </div>
                <div className="row" style={{ marginTop: 8 }}>
                  <label className="field">
                    Size
                    <select
                      value={`${p.width}x${p.height}`}
                      onChange={(e) => {
                        const [w, h] = e.target.value.split('x').map(Number)
                        updatePending(p.key, { width: w, height: h })
                      }}
                    >
                      {!sizes.some((s) => s.width === p.width && s.height === p.height) && (
                        <option value={`${p.width}x${p.height}`}>{p.width}x{p.height} (custom)</option>
                      )}
                      {sizes.map((s) => (
                        <option key={s.id} value={`${s.width}x${s.height}`}>
                          {s.width}x{s.height}
                        </option>
                      ))}
                    </select>
                  </label>
                  {is2x(p) ? (
                    <span className="badge ok">2x OK ({p.imgWidth}x{p.imgHeight})</span>
                  ) : (
                    <span className="badge warn">
                      Expected {p.width * 2}x{p.height * 2}, file is {p.imgWidth}x{p.imgHeight}
                    </span>
                  )}
                </div>
                {p.error && <p className="error">{p.error}</p>}
                <div className="row" style={{ marginTop: 10 }}>
                  <button className="primary" disabled={p.saving || !p.creative.trim()} onClick={() => savePending(p)}>
                    {p.saving ? 'Saving…' : 'Save template'}
                  </button>
                  <button
                    className="secondary"
                    onClick={() => {
                      URL.revokeObjectURL(p.url)
                      setPending((prev) => prev.filter((x) => x.key !== p.key))
                    }}
                  >
                    Discard
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <h2>Logo</h2>
      <div className="card row">
        {settings?.logoPath ? (
          <img src={`/assets/${settings.logoPath}`} alt="Logo" style={{ height: 40 }} />
        ) : (
          <span className="muted">No logo uploaded yet. Upload once (SVG or PNG); place and scale it per template in the editor.</span>
        )}
        <button className="secondary" onClick={() => logoInput.current?.click()}>
          {settings?.logoPath ? 'Replace logo' : 'Upload logo'}
        </button>
        <input
          ref={logoInput}
          type="file"
          accept=".svg,.png"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) uploadLogo(f)
            e.target.value = ''
          }}
        />
      </div>

      <h2>Saved templates ({templates.length})</h2>
      {templates.length === 0 && <p className="muted">Nothing yet — drop background PNGs above to create templates.</p>}
      {[...byCreative.entries()].map(([creative, list]) => (
        <div key={creative} style={{ marginBottom: 18 }}>
          <div className="row" style={{ margin: '12px 0 8px' }}>
            <h2 style={{ margin: 0 }}>{creative}</h2>
            <button
              className="secondary"
              onClick={() => {
                const src = list[0].config
                setDup({
                  source: creative,
                  target: '',
                  pattern: src.headline.pattern,
                  stat: src.stat.statText,
                  sub: src.stat.subText,
                })
              }}
            >
              Duplicate creative…
            </button>
            <button className="secondary" onClick={() => renameCreative(creative)}>
              Rename
            </button>
          </div>
          {dup?.source === creative && (
            <div className="card" style={{ marginBottom: 12, maxWidth: 560 }}>
              <p className="muted" style={{ marginTop: 0 }}>
                Copies all {list.length} format{list.length === 1 ? '' : 's'} of "{creative}" — same backgrounds and
                layouts — as a new creative with these texts. Leave a stat field empty to skip that line.
              </p>
              <div className="controls-grid">
                <label className="field wide">
                  New creative name (used in output file names)
                  <input value={dup.target} autoFocus onChange={(e) => setDup({ ...dup, target: e.target.value })} />
                </label>
                <label className="field wide">
                  Headline pattern
                  <textarea rows={2} value={dup.pattern} onChange={(e) => setDup({ ...dup, pattern: e.target.value })} />
                </label>
                <label className="field">
                  Stat (large line)
                  <input value={dup.stat} onChange={(e) => setDup({ ...dup, stat: e.target.value })} />
                </label>
                <label className="field">
                  Sub-line
                  <input value={dup.sub} onChange={(e) => setDup({ ...dup, sub: e.target.value })} />
                </label>
              </div>
              <div className="row" style={{ marginTop: 12 }}>
                <button className="primary" disabled={!dup.target.trim() || dupBusy} onClick={submitDuplicate}>
                  {dupBusy ? 'Duplicating…' : `Create ${list.length} template${list.length === 1 ? '' : 's'}`}
                </button>
                <button className="secondary" onClick={() => setDup(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          <div className="template-grid">
            {list.map((t) => (
              <div className="card template-card" key={t.id}>
                <img src={`/assets/${t.backgroundPath}`} alt={`${t.creative} ${t.width}x${t.height}`} />
                <p style={{ margin: '8px 0 0', fontSize: 12, lineHeight: 1.4 }}>
                  <strong>{t.config.headline.pattern || <span className="muted">(no headline)</span>}</strong>
                  <br />
                  <span className="muted">
                    {[t.config.stat.statText, t.config.stat.subText].filter((s) => s.trim()).join(' · ') || '(no stat block)'}
                  </span>
                </p>
                <div className="row" style={{ marginTop: 8, justifyContent: 'space-between' }}>
                  <strong>{t.width}x{t.height}</strong>
                  {t.bgWidth === t.width * 2 && t.bgHeight === t.height * 2 ? (
                    <span className="badge ok">2x</span>
                  ) : (
                    <span className="badge warn">bg {t.bgWidth}x{t.bgHeight}</span>
                  )}
                </div>
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="primary" onClick={() => onEdit(t.id)}>
                    Edit
                  </button>
                  <button
                    className="danger"
                    onClick={() => {
                      if (window.confirm(`Delete template "${t.creative}" ${t.width}x${t.height}?`)) {
                        api.deleteTemplate(t.id).then(refresh).catch((e) => setNotice(e.message))
                      }
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
