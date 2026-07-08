import { useEffect, useRef, useState } from 'react'
import type { Company } from '../../shared/types'
import { api } from '../api'
import { parseCompanyFile, type ImportResult } from '../importCompanies'
import { findSanitizeCollisions, sanitizeName as sanitizePreview } from '../../shared/sanitize'

export default function CompaniesPage() {
  const [companies, setCompanies] = useState<Company[]>([])
  const [newName, setNewName] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<(ImportResult & { fileName: string }) | null>(null)
  const [importing, setImporting] = useState(false)
  const [edits, setEdits] = useState<Record<number, string>>({})
  const fileInput = useRef<HTMLInputElement>(null)

  const refresh = () => api.getCompanies().then(setCompanies).catch((e) => setError(e.message))
  useEffect(() => {
    refresh()
  }, [])

  async function addOne() {
    const name = newName.trim()
    if (!name) return
    try {
      await api.addCompany(name)
      setNewName('')
      refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function onFile(file: File) {
    setError(null)
    setNotice(null)
    try {
      const result = await parseCompanyFile(file)
      if (result.names.length === 0) {
        setError(`No company names found in ${file.name} (reads the first column).`)
        return
      }
      setPreview({ ...result, fileName: file.name })
    } catch (e) {
      setError(`Could not read ${file.name}: ${(e as Error).message}`)
    }
  }

  async function confirmImport() {
    if (!preview) return
    setImporting(true)
    try {
      const res = await api.addCompaniesBulk(preview.names)
      setNotice(`Imported ${res.added} new compan${res.added === 1 ? 'y' : 'ies'}${res.skipped > 0 ? `, ${res.skipped} already existed` : ''}.`)
      setPreview(null)
      refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setImporting(false)
    }
  }

  async function saveOverride(c: Company) {
    const value = edits[c.id] ?? c.displayOverride ?? ''
    try {
      await api.setCompanyOverride(c.id, value)
      setEdits((prev) => {
        const next = { ...prev }
        delete next[c.id]
        return next
      })
      refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div style={{ maxWidth: 900 }}>
      <h1>Companies ({companies.length})</h1>
      {error && (
        <p className="error">
          {error} <button className="secondary" onClick={() => setError(null)}>Dismiss</button>
        </p>
      )}
      {notice && <p className="status-ok">{notice}</p>}
      {findSanitizeCollisions(companies.map((c) => c.name)).map((group, i) => (
        <p className="badge warn" key={i}>
          Folder collision: {group.join(' and ')} share the output folder "{sanitizePreview(group[0])}" — their files will
          overwrite each other. Adjust one of the names.
        </p>
      ))}

      <div className="card">
        <div className="row">
          <label className="field" style={{ flex: 1, minWidth: 240 }}>
            Add a company
            <input
              value={newName}
              placeholder="Company name"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addOne()}
            />
          </label>
          <button className="primary" disabled={!newName.trim()} onClick={addOne}>
            Add
          </button>
          <span className="muted">or</span>
          <button className="secondary" onClick={() => fileInput.current?.click()}>
            Import .xlsx / .csv
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".xlsx,.xls,.csv"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) onFile(f)
              e.target.value = ''
            }}
          />
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Import reads the first column, skips a header row if it looks like one, trims whitespace, and removes duplicates.
        </p>
      </div>

      {preview && (
        <div className="card" style={{ marginTop: 14 }}>
          <h2 style={{ marginTop: 0 }}>Confirm import from {preview.fileName}</h2>
          <p className="muted">
            {preview.names.length} name{preview.names.length === 1 ? '' : 's'} to import
            {preview.droppedHeader && ' · skipped a header row'}
            {preview.duplicatesRemoved > 0 && ` · removed ${preview.duplicatesRemoved} duplicate${preview.duplicatesRemoved === 1 ? '' : 's'}`}
            . Existing companies are left untouched.
          </p>
          <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 8 }}>
            {preview.names.map((n, i) => (
              <div key={i} style={{ fontSize: 13, padding: '2px 0' }}>
                {n} <span className="muted" style={{ fontSize: 11 }}>→ {sanitizePreview(n)}/</span>
              </div>
            ))}
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="primary" disabled={importing} onClick={confirmImport}>
              {importing ? 'Importing…' : `Import ${preview.names.length}`}
            </button>
            <button className="secondary" onClick={() => setPreview(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {companies.length > 0 && (
        <table className="gen-table">
          <thead>
            <tr>
              <th>Company (original)</th>
              <th>Display name on ad (override)</th>
              <th>Output folder</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {companies.map((c) => {
              const editing = edits[c.id] ?? c.displayOverride ?? ''
              const dirty = (edits[c.id] ?? c.displayOverride ?? '') !== (c.displayOverride ?? '')
              return (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>
                    <input
                      value={editing}
                      placeholder={c.name}
                      style={{ width: '100%' }}
                      onChange={(e) => setEdits((prev) => ({ ...prev, [c.id]: e.target.value }))}
                      onKeyDown={(e) => e.key === 'Enter' && saveOverride(c)}
                    />
                  </td>
                  <td>
                    <code className="path">{sanitizePreview(c.name)}/</code>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {dirty && (
                      <button className="primary" onClick={() => saveOverride(c)}>
                        Save
                      </button>
                    )}
                    <button
                      className="danger"
                      onClick={() => {
                        if (window.confirm(`Remove "${c.name}" from the company list?`)) {
                          api.deleteCompany(c.id).then(refresh).catch((e) => setError(e.message))
                        }
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
