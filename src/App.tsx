import { useState } from 'react'
import TemplatesPage from './pages/TemplatesPage'
import EditorPage from './pages/EditorPage'
import GeneratePage from './pages/GeneratePage'
import BatchPage from './pages/BatchPage'
import CompaniesPage from './pages/CompaniesPage'
import SettingsPage from './pages/SettingsPage'

export type View =
  | { name: 'templates' }
  | { name: 'editor'; templateId: number }
  | { name: 'generate' }
  | { name: 'batch' }
  | { name: 'companies' }
  | { name: 'settings' }

export default function App() {
  const [view, setView] = useState<View>({ name: 'templates' })

  const tab = (name: View['name'], label: string) => (
    <button
      className={view.name === name ? 'active' : ''}
      onClick={() => setView({ name } as View)}
    >
      {label}
    </button>
  )

  return (
    <>
      <header className="topbar">
        <div className="brand">
          Banner<span>forge</span>
        </div>
        <nav>
          {tab('templates', 'Templates')}
          {tab('companies', 'Companies')}
          {tab('generate', 'Generate')}
          {tab('batch', 'Batch')}
          {tab('settings', 'Settings')}
        </nav>
      </header>
      <main>
        {view.name === 'templates' && (
          <TemplatesPage onEdit={(templateId) => setView({ name: 'editor', templateId })} />
        )}
        {view.name === 'editor' && (
          <EditorPage templateId={view.templateId} onBack={() => setView({ name: 'templates' })} />
        )}
        {view.name === 'generate' && <GeneratePage />}
        {view.name === 'batch' && <BatchPage />}
        {view.name === 'companies' && <CompaniesPage />}
        {view.name === 'settings' && <SettingsPage />}
      </main>
    </>
  )
}
