'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

// Sidebar nav link with auto-detected active state.
// Active state styling comes from the .nav-link CSS class in globals.css
// — keep behavior here in JS, presentation in CSS.
export default function NavLink({ href, label, highlight = false }) {
  const pathname = usePathname()
  const isActive = pathname === href || (href !== '/' && pathname?.startsWith(href + '/'))
  return (
    <Link
      href={href}
      className="nav-link"
      data-active={isActive ? 'true' : 'false'}
      data-highlight={!isActive && highlight ? 'true' : 'false'}
    >
      {label}
    </Link>
  )
}
