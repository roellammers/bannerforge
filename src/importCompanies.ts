import * as XLSX from 'xlsx'

export interface ImportResult {
  names: string[] // final, deduped, header-skipped, trimmed
  rawCount: number // rows with a non-empty first cell
  droppedHeader: boolean
  duplicatesRemoved: number
}

const HEADER_HINTS = new Set([
  'company', 'companies', 'name', 'names', 'organisation', 'organization', 'org',
  'account', 'accounts', 'customer', 'customers', 'client', 'clients', 'target', 'targets',
  'bolag', 'företag', 'foretag', 'kund', 'kunder',
])

// Treat the first row as a header only if every word in it is a header hint,
// so a real company like "Customer One" or "Bank of X" is never dropped.
function looksLikeHeader(first: string): boolean {
  const words = first.trim().toLowerCase().split(/[\s_-]+/).filter(Boolean)
  return words.length > 0 && words.every((w) => HEADER_HINTS.has(w))
}

// Minimal CSV: takes the first field of each line, honoring double-quoted
// fields that may contain commas. Good enough for a first-column read.
function parseCsvFirstColumn(text: string): string[] {
  const out: string[] = []
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    if (rawLine.trim() === '') continue
    let field: string
    if (rawLine[0] === '"') {
      let i = 1
      let s = ''
      while (i < rawLine.length) {
        if (rawLine[i] === '"') {
          if (rawLine[i + 1] === '"') {
            s += '"'
            i += 2
          } else break
        } else {
          s += rawLine[i]
          i++
        }
      }
      field = s
    } else {
      const comma = rawLine.indexOf(',')
      const semi = rawLine.indexOf(';')
      const sep = [comma, semi].filter((n) => n >= 0).sort((a, b) => a - b)[0]
      field = sep === undefined ? rawLine : rawLine.slice(0, sep)
    }
    out.push(field.trim())
  }
  return out
}

function firstColumnFromRows(rows: unknown[][]): string[] {
  return rows.map((r) => (r && r[0] != null ? String(r[0]).trim() : '')).filter((s) => s !== '')
}

function finalize(firstColumn: string[]): ImportResult {
  const nonEmpty = firstColumn.filter((s) => s !== '')
  const rawCount = nonEmpty.length
  let rows = nonEmpty
  let droppedHeader = false
  if (rows.length > 0 && looksLikeHeader(rows[0])) {
    rows = rows.slice(1)
    droppedHeader = true
  }
  const seen = new Set<string>()
  const names: string[] = []
  let duplicatesRemoved = 0
  for (const name of rows) {
    const key = name.toLowerCase()
    if (seen.has(key)) {
      duplicatesRemoved++
      continue
    }
    seen.add(key)
    names.push(name)
  }
  return { names, rawCount, droppedHeader, duplicatesRemoved }
}

export async function parseCompanyFile(file: File): Promise<ImportResult> {
  const isCsv = /\.csv$/i.test(file.name)
  if (isCsv) {
    const text = await file.text()
    return finalize(parseCsvFirstColumn(text))
  }
  // .xlsx / .xls
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })
  const sheet = wb.Sheets[wb.SheetNames[0]]
  if (!sheet) return finalize([])
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false, defval: '' })
  return finalize(firstColumnFromRows(rows))
}
