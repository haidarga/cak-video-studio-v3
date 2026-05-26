import { useStudio } from '../store'

export default function ToastHost() {
  const { toasts } = useStudio()
  return (
    <div style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 999, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {toasts.map((t) => (
        <div
          key={t.id}
          style={{
            padding: '10px 18px', borderRadius: 10, fontSize: 13, fontWeight: 600,
            background: t.type === 'error' ? '#7f1d1d' : '#14532d', color: '#fff',
            border: `1px solid ${t.type === 'error' ? '#991b1b' : '#166534'}`,
            boxShadow: '0 8px 24px rgba(0,0,0,.4)', animation: 'fadeIn .2s ease',
          }}
        >
          {t.msg}
        </div>
      ))}
    </div>
  )
}
