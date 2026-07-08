import { useEffect, useRef, useState } from 'react'
import type { AppSettings, Company, Palette, TemplateConfig, TemplateRecord, TextStyle } from '../../shared/types'
import { api } from '../api'
import { loadImage, renderTemplate, type RenderMetrics } from '../render/engine'
import { configFontWeights, ensureFonts } from '../render/fonts'

type ElementKey = 'headline' | 'stat' | 'logo'
type DragMode = 'move' | 'resize'

const SAMPLE_COMPANIES = ['Avarda', 'Länsförsäkringar Bank']

function applyDrag(orig: TemplateConfig, kind: ElementKey, mode: DragMode, dx: number, dy: number): TemplateConfig {
  const next = structuredClone(orig)
  if (mode === 'move') {
    if (kind === 'headline') {
      next.headline.x = orig.headline.x + dx
      next.headline.y = orig.headline.y + dy
    } else if (kind === 'stat') {
      next.stat.x = orig.stat.x + dx
      if (orig.stat.positionMode === 'follow-headline') {
        next.stat.followGap = Math.max(0, orig.stat.followGap + dy)
      } else {
        next.stat.y = orig.stat.y + dy
      }
    } else {
      next.logo.x = orig.logo.x + dx
      next.logo.y = orig.logo.y + dy
    }
  } else {
    if (kind === 'headline') {
      // Corner handle sizes the auto-shrink box in both dimensions.
      next.headline.maxWidth = Math.max(20, orig.headline.maxWidth + dx)
      next.headline.maxHeight = Math.max(10, orig.headline.maxHeight + dy)
    } else if (kind === 'stat') next.stat.maxWidth = Math.max(20, orig.stat.maxWidth + dx)
    else next.logo.width = Math.max(10, orig.logo.width + dx)
  }
  return next
}

// "Copy layout" keeps this template's texts but takes everything else
// (positions, sizes, styles, modes) from the source template.
function mergeLayout(current: TemplateConfig, source: TemplateConfig): TemplateConfig {
  return {
    headline: { ...structuredClone(source.headline), pattern: current.headline.pattern },
    stat: {
      ...structuredClone(source.stat),
      statText: current.stat.statText,
      subText: current.stat.subText,
    },
    logo: structuredClone(source.logo),
  }
}

function NumField(props: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; disabled?: boolean }) {
  return (
    <label className="field">
      {props.label}
      <input
        type="number"
        value={props.value}
        step={props.step ?? 1}
        min={props.min}
        disabled={props.disabled}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (!Number.isNaN(v)) props.onChange(v)
        }}
      />
    </label>
  )
}

const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900]

function WeightSelect(props: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="field">
      {props.label}
      <select value={props.value} onChange={(e) => props.onChange(Number(e.target.value))}>
        {WEIGHTS.map((w) => (
          <option key={w} value={w}>
            {w}
          </option>
        ))}
      </select>
    </label>
  )
}

function ColorField(props: { label: string; value: string; palette: Palette; onChange: (v: string) => void }) {
  return (
    <label className="field">
      {props.label}
      <div className="row" style={{ gap: 6 }}>
        <input type="color" value={props.value} style={{ padding: 2, width: 44, height: 30 }} onChange={(e) => props.onChange(e.target.value)} />
        <div className="swatches">
          {Object.entries(props.palette).map(([name, color]) => (
            <button key={name} type="button" className="swatch" title={name} style={{ background: color }} onClick={() => props.onChange(color)} />
          ))}
        </div>
      </div>
    </label>
  )
}

function StyleFields(props: { style: TextStyle; palette: Palette; onChange: (s: TextStyle) => void }) {
  const { style, palette, onChange } = props
  return (
    <div className="controls-grid">
      <NumField label="Font size" value={style.fontSize} min={6} onChange={(v) => onChange({ ...style, fontSize: v })} />
      <WeightSelect label="Weight" value={style.fontWeight} onChange={(v) => onChange({ ...style, fontWeight: v })} />
      <NumField label="Line height" value={style.lineHeight} step={0.05} min={0.7} onChange={(v) => onChange({ ...style, lineHeight: v })} />
      <NumField label="Letter spacing" value={style.letterSpacing} step={0.1} onChange={(v) => onChange({ ...style, letterSpacing: v })} />
      <label className="field">
        Align
        <select value={style.align} onChange={(e) => onChange({ ...style, align: e.target.value as TextStyle['align'] })}>
          <option value="left">Left</option>
          <option value="center">Center</option>
          <option value="right">Right</option>
        </select>
      </label>
      <ColorField label="Color" value={style.color} palette={palette} onChange={(v) => onChange({ ...style, color: v })} />
    </div>
  )
}

export default function EditorPage({ templateId, onBack }: { templateId: number; onBack: () => void }) {
  const [template, setTemplate] = useState<TemplateRecord | null>(null)
  const [config, setConfig] = useState<TemplateConfig | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [allTemplates, setAllTemplates] = useState<TemplateRecord[]>([])
  const [bgImg, setBgImg] = useState<HTMLImageElement | null>(null)
  const [logoImg, setLogoImg] = useState<HTMLImageElement | null>(null)
  const [sampleCompany, setSampleCompany] = useState(SAMPLE_COMPANIES[0])
  const [zoom, setZoom] = useState<1 | 2>(2)
  const [selected, setSelected] = useState<ElementKey>('headline')
  const [metrics, setMetrics] = useState<RenderMetrics | null>(null)
  const [dirty, setDirty] = useState(false)
  // Snapshot of the last-saved config, so Cancel can revert unsaved edits.
  const [savedConfig, setSavedConfig] = useState<TemplateConfig | null>(null)
  const [leaving, setLeaving] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [companies, setCompanies] = useState<Company[]>([])
  const [test, setTest] = useState<{ fit: number; shrunk: number; overflow: string[] } | null>(null)
  const [testing, setTesting] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragRef = useRef<{ kind: ElementKey; mode: DragMode; startX: number; startY: number; orig: TemplateConfig } | null>(null)

  useEffect(() => {
    api
      .getTemplate(templateId)
      .then((t) => {
        setTemplate(t)
        setConfig(t.config)
        setSavedConfig(structuredClone(t.config))
        setDirty(false)
      })
      .catch((e) => setError(e.message))
    api.getSettings().then(setSettings).catch(() => {})
    api.getTemplates().then(setAllTemplates).catch(() => {})
    api.getCompanies().then(setCompanies).catch(() => {})
  }, [templateId])

  useEffect(() => {
    if (!template) return
    loadImage(`/assets/${template.backgroundPath}`).then(setBgImg).catch((e) => setError(e.message))
  }, [template?.backgroundPath])

  useEffect(() => {
    if (!settings?.logoPath) return
    loadImage(`/assets/${settings.logoPath}`).then(setLogoImg).catch(() => setError('Failed to load logo asset'))
  }, [settings?.logoPath])

  // Re-render the canvas whenever anything visible changes. The preview goes
  // through the exact same engine as the exported file.
  useEffect(() => {
    if (!template || !config || !canvasRef.current) return
    let alive = true
    ensureFonts(configFontWeights(config)).then(() => {
      if (!alive || !canvasRef.current) return
      try {
        setMetrics(
          renderTemplate({
            config,
            width: template.width,
            height: template.height,
            company: sampleCompany || 'Company',
            background: bgImg,
            logo: logoImg,
            target: canvasRef.current,
            displayScale: zoom,
          })
        )
      } catch (e) {
        setError((e as Error).message)
      }
    })
    return () => {
      alive = false
    }
  }, [template, config, sampleCompany, bgImg, logoImg, zoom])

  function patch(updater: (c: TemplateConfig) => TemplateConfig) {
    setConfig((c) => (c ? updater(c) : c))
    setDirty(true)
  }

  function startDrag(e: React.PointerEvent, kind: ElementKey, mode: DragMode) {
    if (!config) return
    e.preventDefault()
    e.stopPropagation()
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      // synthetic events may carry an inactive pointerId; drag still works
    }
    dragRef.current = { kind, mode, startX: e.clientX, startY: e.clientY, orig: config }
    setSelected(kind)
  }

  function moveDrag(e: React.PointerEvent) {
    const d = dragRef.current
    if (!d) return
    // Pointer deltas are in screen px; config space is 1x banner px.
    const dx = Math.round((e.clientX - d.startX) / zoom)
    const dy = Math.round((e.clientY - d.startY) / zoom)
    setConfig(applyDrag(d.orig, d.kind, d.mode, dx, dy))
    setDirty(true)
  }

  function endDrag() {
    dragRef.current = null
  }

  function nudge(kind: ElementKey, dx: number, dy: number) {
    patch((c) => applyDrag(c, kind, 'move', dx, dy))
  }

  // Long-name test tool: render every company through the current (unsaved)
  // config offscreen and report which overflow the headline box at the floor.
  async function runTest() {
    if (!config || !template || companies.length === 0) return
    setTesting(true)
    try {
      await ensureFonts(configFontWeights(config))
      const scratch = document.createElement('canvas')
      let fit = 0
      let shrunk = 0
      const overflow: string[] = []
      for (const c of companies) {
        const displayName = c.displayOverride?.trim() || c.name
        const m = renderTemplate({
          config,
          width: template.width,
          height: template.height,
          company: displayName,
          background: null,
          logo: null,
          target: scratch,
        })
        if (m.headlineOverflow) overflow.push(displayName)
        else if (m.headlineScale < 0.999) shrunk++
        else fit++
      }
      setTest({ fit, shrunk, overflow })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setTesting(false)
    }
  }

  async function save(): Promise<boolean> {
    if (!config) return false
    setSaving(true)
    setError(null)
    try {
      await api.saveConfig(templateId, config)
      setSavedConfig(structuredClone(config))
      setDirty(false)
      return true
    } catch (e) {
      setError((e as Error).message)
      return false
    } finally {
      setSaving(false)
    }
  }

  // Discard unsaved edits, reverting to the last-saved config.
  function cancelEdits() {
    if (savedConfig) setConfig(structuredClone(savedConfig))
    setDirty(false)
    setError(null)
  }

  // Back: leave immediately if clean, otherwise ask what to do.
  function requestBack() {
    if (dirty) setLeaving(true)
    else onBack()
  }

  if (error && !template) return <p className="error">{error}</p>
  if (!template || !config || !settings) return <p className="muted">Loading…</p>

  const palette = settings.palette
  const sameSize = allTemplates.filter((t) => t.id !== template.id && t.width === template.width && t.height === template.height)

  const overlay = (kind: ElementKey, box: { x: number; y: number; width: number; height: number }, handle: 'right' | 'corner') => (
    <div
      key={kind}
      className={`overlay ${selected === kind ? 'selected' : ''}`}
      style={{
        left: box.x * zoom,
        top: box.y * zoom,
        width: Math.max(box.width * zoom, 8),
        height: Math.max(box.height * zoom, 8),
      }}
      tabIndex={0}
      title={kind}
      onPointerDown={(e) => startDrag(e, kind, 'move')}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 10 : 1
        if (e.key === 'ArrowLeft') nudge(kind, -step, 0)
        else if (e.key === 'ArrowRight') nudge(kind, step, 0)
        else if (e.key === 'ArrowUp') nudge(kind, 0, -step)
        else if (e.key === 'ArrowDown') nudge(kind, 0, step)
        else return
        e.preventDefault()
      }}
    >
      <div
        className={`handle ${handle}`}
        onPointerDown={(e) => startDrag(e, kind, 'resize')}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
      />
    </div>
  )

  // Headline overlay shows the auto-shrink box (maxWidth × maxHeight), the
  // constraint the user edits — not the drawn text bounds.
  const headlineBox = {
    x: config.headline.x,
    y: config.headline.y,
    width: config.headline.maxWidth,
    height: config.headline.maxHeight,
  }

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
        <div className="row">
          <button
            className="secondary"
            onClick={requestBack}
          >
            ← Back
          </button>
          <h1 style={{ margin: 0 }}>
            {template.creative} <span className="muted">{template.width}x{template.height}</span>
          </h1>
        </div>
        <div className="row">
          {sameSize.length > 0 && (
            <select
              value=""
              onChange={(e) => {
                const src = sameSize.find((t) => t.id === Number(e.target.value))
                if (src && window.confirm(`Copy layout from "${src.creative}"? Texts are kept.`)) {
                  patch((c) => mergeLayout(c, src.config))
                }
              }}
            >
              <option value="" disabled>
                Copy layout from…
              </option>
              {sameSize.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.creative}
                </option>
              ))}
            </select>
          )}
          <button className="secondary" disabled={!dirty || saving} onClick={cancelEdits}>
            Cancel
          </button>
          <button className="primary" disabled={!dirty || saving} onClick={save}>
            {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </button>
        </div>
      </div>

      {leaving && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(18,32,25,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
          onClick={() => setLeaving(false)}
        >
          <div className="card" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginTop: 0 }}>Unsaved changes</h2>
            <p className="muted">You have unsaved edits to this template.</p>
            {error && <p className="error">{error}</p>}
            <div className="row" style={{ marginTop: 12 }}>
              <button
                className="primary"
                disabled={saving}
                onClick={async () => {
                  if (await save()) {
                    setLeaving(false)
                    onBack()
                  }
                }}
              >
                {saving ? 'Saving…' : 'Save and leave'}
              </button>
              <button
                className="danger"
                disabled={saving}
                onClick={() => {
                  setLeaving(false)
                  onBack()
                }}
              >
                Discard and leave
              </button>
              <button className="secondary" disabled={saving} onClick={() => setLeaving(false)}>
                Keep editing
              </button>
            </div>
          </div>
        </div>
      )}

      {error && <p className="error">{error}</p>}
      {template.bgWidth !== template.width * 2 || template.bgHeight !== template.height * 2 ? (
        <p className="badge warn">
          Background is {template.bgWidth}x{template.bgHeight}, expected {template.width * 2}x{template.height * 2} (2x) — it will be stretched.
        </p>
      ) : null}

      <div className="row" style={{ marginBottom: 12 }}>
        <label className="field">
          Sample company
          <input
            list="sample-companies"
            value={sampleCompany}
            style={{ width: 260 }}
            onChange={(e) => setSampleCompany(e.target.value)}
          />
        </label>
        <datalist id="sample-companies">
          {SAMPLE_COMPANIES.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <label className="field">
          Preview zoom
          <div className="panel-tabs" style={{ width: 140 }}>
            {([1, 2] as const).map((z) => (
              <button key={z} className={zoom === z ? 'active' : ''} onClick={() => setZoom(z)}>
                {z * 100}%
              </button>
            ))}
          </div>
        </label>
        {metrics && metrics.headlineOverflow && (
          <span className="badge warn">Overflows at floor — would be flagged</span>
        )}
        {metrics && !metrics.headlineOverflow && metrics.headlineScale < 0.999 && (
          <span className="badge ok">Shrunk to {Math.round(metrics.headlineScale * 100)}% to fit</span>
        )}
        {!settings.logoPath && <span className="badge warn">No logo uploaded yet — upload it on the Templates page.</span>}
        <button className="secondary" disabled={testing || companies.length === 0} onClick={runTest} title={companies.length === 0 ? 'Add companies first' : ''}>
          {testing ? 'Testing…' : `Test all ${companies.length} companies`}
        </button>
      </div>

      {test && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong>
              Overflow test (current layout): {test.fit} fit · {test.shrunk} shrink to fit · {test.overflow.length} overflow
            </strong>
            <button className="secondary" onClick={() => setTest(null)}>
              Close
            </button>
          </div>
          {test.overflow.length > 0 ? (
            <>
              <p className="muted" style={{ margin: '8px 0 4px' }}>
                These still overflow at the floor and would be flagged — click one to preview it, then widen the box, raise
                max height, lower the floor, or set a shorter display name on the Companies page:
              </p>
              <div className="row" style={{ gap: 6 }}>
                {test.overflow.map((n) => (
                  <button key={n} className="badge warn" style={{ cursor: 'pointer', border: 'none' }} onClick={() => setSampleCompany(n)}>
                    {n}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="status-ok" style={{ margin: '8px 0 0' }}>
              Every company fits within the shrink floor. 🎉
            </p>
          )}
        </div>
      )}

      <div className="editor-layout">
        <div className="editor-stage-wrap">
          <div className="stage" style={{ width: template.width * zoom, height: template.height * zoom }}>
            <canvas ref={canvasRef} style={{ width: template.width * zoom, height: template.height * zoom }} />
            {metrics && (
              <>
                {overlay('headline', headlineBox, 'corner')}
                {overlay('stat', metrics.stat, 'right')}
                {overlay('logo', metrics.logo, 'corner')}
              </>
            )}
          </div>
        </div>

        <div className="editor-panel">
          <div className="panel-tabs">
            {(['headline', 'stat', 'logo'] as ElementKey[]).map((k) => (
              <button key={k} className={selected === k ? 'active' : ''} onClick={() => setSelected(k)}>
                {k === 'headline' ? 'Headline' : k === 'stat' ? 'Stat block' : 'Logo'}
              </button>
            ))}
          </div>

          {selected === 'headline' && (
            <div className="card">
              <div className="controls-grid">
                <label className="field wide">
                  Text pattern — use {'{company}'} for the company name; line breaks are manual breaks
                  <textarea
                    rows={3}
                    value={config.headline.pattern}
                    onChange={(e) => patch((c) => ({ ...c, headline: { ...c.headline, pattern: e.target.value } }))}
                  />
                </label>
                <NumField label="X" value={config.headline.x} onChange={(v) => patch((c) => ({ ...c, headline: { ...c.headline, x: v } }))} />
                <NumField label="Y" value={config.headline.y} onChange={(v) => patch((c) => ({ ...c, headline: { ...c.headline, y: v } }))} />
                <NumField label="Max width (wrap)" value={config.headline.maxWidth} min={20} onChange={(v) => patch((c) => ({ ...c, headline: { ...c.headline, maxWidth: v } }))} />
                <NumField label="Max height (shrink box)" value={config.headline.maxHeight} min={10} onChange={(v) => patch((c) => ({ ...c, headline: { ...c.headline, maxHeight: v } }))} />
                <NumField
                  label="Shrink floor %"
                  value={Math.round(config.headline.shrinkFloor * 100)}
                  min={10}
                  onChange={(v) => patch((c) => ({ ...c, headline: { ...c.headline, shrinkFloor: Math.min(1, Math.max(0.1, v / 100)) } }))}
                />
              </div>
              <p className="muted" style={{ margin: '8px 0 0' }}>
                If the headline exceeds this box, the font shrinks in steps to the floor. If it still overflows at the floor,
                the ad renders anyway and the company is flagged for review.
              </p>
              <h2>Base text style</h2>
              <StyleFields style={config.headline.style} palette={palette} onChange={(s) => patch((c) => ({ ...c, headline: { ...c.headline, style: s } }))} />
              <h2>{'{company}'} span style</h2>
              <div className="controls-grid">
                <WeightSelect
                  label="Weight"
                  value={config.headline.companyStyle.fontWeight}
                  onChange={(v) => patch((c) => ({ ...c, headline: { ...c.headline, companyStyle: { ...c.headline.companyStyle, fontWeight: v } } }))}
                />
                <ColorField
                  label="Color"
                  value={config.headline.companyStyle.color}
                  palette={palette}
                  onChange={(v) => patch((c) => ({ ...c, headline: { ...c.headline, companyStyle: { ...c.headline.companyStyle, color: v } } }))}
                />
              </div>
            </div>
          )}

          {selected === 'stat' && (
            <div className="card">
              <div className="controls-grid">
                <label className="field wide">
                  Stat (large line)
                  <input value={config.stat.statText} onChange={(e) => patch((c) => ({ ...c, stat: { ...c.stat, statText: e.target.value } }))} />
                </label>
                <label className="field wide">
                  Sub-line
                  <input value={config.stat.subText} onChange={(e) => patch((c) => ({ ...c, stat: { ...c.stat, subText: e.target.value } }))} />
                </label>
                <label className="field">
                  Position mode
                  <select
                    value={config.stat.positionMode}
                    onChange={(e) => patch((c) => ({ ...c, stat: { ...c.stat, positionMode: e.target.value as 'absolute' | 'follow-headline' } }))}
                  >
                    <option value="absolute">Absolute</option>
                    <option value="follow-headline">Follow headline</option>
                  </select>
                </label>
                {config.stat.positionMode === 'follow-headline' ? (
                  <NumField label="Gap below headline" value={config.stat.followGap} min={0} onChange={(v) => patch((c) => ({ ...c, stat: { ...c.stat, followGap: v } }))} />
                ) : (
                  <NumField label="Y" value={config.stat.y} onChange={(v) => patch((c) => ({ ...c, stat: { ...c.stat, y: v } }))} />
                )}
                <NumField label="X" value={config.stat.x} onChange={(v) => patch((c) => ({ ...c, stat: { ...c.stat, x: v } }))} />
                <NumField label="Max width (wrap)" value={config.stat.maxWidth} min={20} onChange={(v) => patch((c) => ({ ...c, stat: { ...c.stat, maxWidth: v } }))} />
                <NumField label="Stat ↔ sub gap" value={config.stat.gap} onChange={(v) => patch((c) => ({ ...c, stat: { ...c.stat, gap: v } }))} />
              </div>
              <h2>Stat style</h2>
              <StyleFields style={config.stat.statStyle} palette={palette} onChange={(s) => patch((c) => ({ ...c, stat: { ...c.stat, statStyle: s } }))} />
              <h2>Sub-line style</h2>
              <StyleFields style={config.stat.subStyle} palette={palette} onChange={(s) => patch((c) => ({ ...c, stat: { ...c.stat, subStyle: s } }))} />
            </div>
          )}

          {selected === 'logo' && (
            <div className="card">
              {!settings.logoPath && <p className="muted">Upload the logo on the Templates page first; then position it here.</p>}
              <div className="controls-grid">
                <NumField label="X" value={config.logo.x} onChange={(v) => patch((c) => ({ ...c, logo: { ...c.logo, x: v } }))} />
                <NumField label="Y" value={config.logo.y} onChange={(v) => patch((c) => ({ ...c, logo: { ...c.logo, y: v } }))} />
                <NumField label="Width" value={config.logo.width} min={10} onChange={(v) => patch((c) => ({ ...c, logo: { ...c.logo, width: v } }))} />
              </div>
              <p className="muted">Height follows the logo's aspect ratio.</p>
            </div>
          )}

          <p className="muted">
            Drag elements on the canvas. Drag the side/corner handle to change wrap width or logo size. Arrow keys nudge (Shift = 10px).
            {config.stat.positionMode === 'follow-headline' && ' Dragging the stat block vertically adjusts its gap below the headline.'}
          </p>
        </div>
      </div>
    </div>
  )
}
