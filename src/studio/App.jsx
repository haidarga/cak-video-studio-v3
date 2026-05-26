import { useState, lazy, Suspense } from 'react'
import { useStudio } from './store'
import Header from './components/Header'
import ToastHost from './components/Toast'
import SettingsModal from './components/SettingsModal'
import BrandModal from './components/BrandModal'
// lazy-load tabs so the initial bundle stays light (Editor pulls in heavy Remotion player only when opened)
const QuickTab = lazy(() => import('./tabs/QuickTab'))
const PipelineTab = lazy(() => import('./tabs/PipelineTab'))
const BulkTab = lazy(() => import('./tabs/BulkTab'))
const TemplateTab = lazy(() => import('./tabs/TemplateTab'))
const ChainTab = lazy(() => import('./tabs/ChainTab'))
const PostProTab = lazy(() => import('./tabs/PostProTab'))
const ResultsTab = lazy(() => import('./tabs/ResultsTab'))
const QCTab = lazy(() => import('./tabs/QCTab'))

const TABS = [
  { id: 'quick', label: '⚡ Quick', C: QuickTab },
  { id: 'pipeline', label: '🎬 Pipeline', C: PipelineTab },
  { id: 'bulk', label: '🏭 Bulk', C: BulkTab },
  { id: 'template', label: '🎯 Template', C: TemplateTab },
  { id: 'chain', label: '🔗 Chain', C: ChainTab },
  { id: 'postpro', label: '🎬 Editor', C: PostProTab },
  { id: 'results', label: '📁 Results', C: ResultsTab },
  { id: 'qc', label: '🧪 QC', C: QCTab },
]

export default function App() {
  const { activeTab, setActiveTab } = useStudio()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [brandsOpen, setBrandsOpen] = useState(false)
  const Active = (TABS.find((t) => t.id === activeTab) || TABS[0]).C

  return (
    <>
      <Header onOpenSettings={() => setSettingsOpen(true)} onOpenBrands={() => setBrandsOpen(true)} />
      <div className="tabs">
        {TABS.map((t) => (
          <div key={t.id} className={'tab' + (t.id === activeTab ? ' active' : '')} onClick={() => setActiveTab(t.id)}>
            {t.label}
          </div>
        ))}
      </div>
      <div className="main">
        <Suspense fallback={<div className="pane active" style={{ padding: 40, color: 'var(--muted)' }}>⏳ Loading…</div>}>
          <Active key={activeTab} />
        </Suspense>
      </div>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <BrandModal open={brandsOpen} onClose={() => setBrandsOpen(false)} />
      <ToastHost />
    </>
  )
}
