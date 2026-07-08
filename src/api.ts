import type { AppSettings, BannerSize, Company, TemplateConfig, TemplateRecord } from '../shared/types'

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`
    try {
      const body = await res.json()
      if (body.error) message = body.error
    } catch {
      /* keep status text */
    }
    const err = new Error(message) as Error & { status: number }
    err.status = res.status
    throw err
  }
  return res.json() as Promise<T>
}

export const api = {
  getTemplates: () => fetch('/api/templates').then((r) => json<TemplateRecord[]>(r)),
  getTemplate: (id: number) => fetch(`/api/templates/${id}`).then((r) => json<TemplateRecord>(r)),
  uploadTemplate: (form: FormData) =>
    fetch('/api/templates', { method: 'POST', body: form }).then((r) =>
      json<{ template: TemplateRecord; is2x: boolean; actual: { width: number; height: number } }>(r)
    ),
  saveConfig: (id: number, config: TemplateConfig) =>
    fetch(`/api/templates/${id}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config }),
    }).then((r) => json<TemplateRecord>(r)),
  deleteTemplate: (id: number) =>
    fetch(`/api/templates/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),
  duplicateCreative: (body: { source: string; target: string; headlinePattern?: string; statText?: string; subText?: string }) =>
    fetch('/api/creatives/duplicate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<{ created: TemplateRecord[] }>(r)),
  updateCreativeCopy: (body: { creative: string; headlinePattern: string; statText: string; subText: string }) =>
    fetch('/api/creatives/ad-copy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<{ updated: number }>(r)),
  renameCreative: (from: string, to: string) =>
    fetch('/api/creatives/rename', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    }).then((r) => json<{ renamed: number }>(r)),

  getSizes: () => fetch('/api/sizes').then((r) => json<BannerSize[]>(r)),
  addSize: (width: number, height: number) =>
    fetch('/api/sizes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ width, height }),
    }).then((r) => json<BannerSize[]>(r)),
  deleteSize: (id: number) =>
    fetch(`/api/sizes/${id}`, { method: 'DELETE' }).then((r) => json<BannerSize[]>(r)),

  getSettings: () => fetch('/api/settings').then((r) => json<AppSettings>(r)),
  saveSettings: (patch: Partial<AppSettings>) =>
    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then((r) => json<AppSettings>(r)),
  uploadLogo: (form: FormData) =>
    fetch('/api/logo', { method: 'POST', body: form }).then((r) => json<{ logoPath: string }>(r)),

  getCompanies: () => fetch('/api/companies').then((r) => json<Company[]>(r)),
  addCompany: (name: string) =>
    fetch('/api/companies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then((r) => json<Company>(r)),
  addCompaniesBulk: (names: string[]) =>
    fetch('/api/companies/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names }),
    }).then((r) => json<{ added: number; skipped: number; total: number }>(r)),
  setCompanyOverride: (id: number, displayOverride: string) =>
    fetch(`/api/companies/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayOverride }),
    }).then((r) => json<Company>(r)),
  deleteCompany: (id: number) =>
    fetch(`/api/companies/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),

  writeRender: (form: FormData) =>
    fetch('/api/render/write', { method: 'POST', body: form }).then((r) =>
      json<{ path: string; bytes: number; compressed: boolean; compressionError: string | null }>(r)
    ),
  getRunHistory: () =>
    fetch('/api/run-history').then((r) => json<Array<{ companyId: number; templateId: number; configHash: string }>>(r)),
  tinifyStatus: () =>
    fetch('/api/tinify/status').then((r) =>
      json<{ configured: boolean; compressionCount: number | null; countUpdatedAt: string | null; monthlyLimit: number }>(r)
    ),
  tinifyCompressFile: (path: string) =>
    fetch('/api/tinify/compress-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }).then((r) => json<{ path: string; bytes: number; saved: number }>(r)),
  openFolder: (path?: string) =>
    fetch('/api/open-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: path ?? '' }),
    }).then((r) => json<{ ok: boolean }>(r)),
}
