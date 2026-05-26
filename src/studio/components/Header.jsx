import { useStudio } from '../store'

export default function Header({ onOpenSettings, onOpenBrands }) {
  const S = useStudio()
  const badge =
    S.keyStatus === 'ok' ? { c: 'badge-green', t: 'Keys OK ✓' } :
    S.keyStatus === 'partial' ? { c: 'badge-amber', t: 'fal.ai only' } :
    { c: 'badge-red', t: 'No Keys' }

  const onBrand = (e) => {
    const id = e.target.value
    if (id) S.applyBrand(id)
    else S.clearBrand()
  }

  return (
    <header>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 11 }}>
        <div className="logo">CAK <span>Video</span> Studio</div>
        <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 500, letterSpacing: '.3px' }}>
          AI Video Pipeline
        </span>
      </div>
      <div className="header-actions">
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'var(--surface2)', border: '1px solid var(--border2)', borderRadius: 'var(--r)', padding: '5px 6px 5px 11px' }}>
          <span style={{ fontSize: 12 }}>🏷️</span>
          <select value={S.activeBrandId || ''} onChange={onBrand}
            style={{ width: 'auto', minWidth: 120, padding: '5px 8px', fontSize: 12, background: 'var(--surface)', borderColor: 'var(--border)' }}>
            <option value="">(no brand)</option>
            {S.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <button className="btn btn-ghost btn-sm" onClick={onOpenBrands} style={{ padding: '5px 11px' }}>Manage</button>
        </div>
        <span className={'badge ' + badge.c}>{badge.t}</span>
        <button className="btn btn-ghost btn-sm" onClick={onOpenSettings}>⚙️ Settings</button>
      </div>
    </header>
  )
}
