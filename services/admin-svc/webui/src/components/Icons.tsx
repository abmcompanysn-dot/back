// Icônes SVG dessinées en ligne (style outline, 24x24, stroke 1.8) — pas
// de bibliothèque externe (cohérent avec le reste du dépôt : client HTTP
// fait main, TOTP en Go pur, etc.), et rend identiquement sur toutes les
// plateformes contrairement aux emoji (police système variable).
import type { SVGProps } from 'react'

function Base(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    />
  )
}

export function IconDashboard(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </Base>
  )
}

export function IconCatalog(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M4 7l8-4 8 4-8 4-8-4z" />
      <path d="M4 7v10l8 4 8-4V7" />
      <path d="M12 11v10" />
    </Base>
  )
}

export function IconStore(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M3 9l1.5-5h15L21 9" />
      <path d="M3 9a2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0" />
      <path d="M5 9v10h14V9" />
      <path d="M9 19v-6h6v6" />
    </Base>
  )
}

export function IconOrders(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M6 2h9l4 4v16H6z" />
      <path d="M15 2v4h4" />
      <path d="M9 13h7" />
      <path d="M9 17h7" />
      <path d="M9 9h2" />
    </Base>
  )
}

export function IconCustomers(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6" />
      <circle cx="17.5" cy="9" r="2.3" />
      <path d="M15.5 14.2c2.5.3 4.5 2.4 4.5 5.3" />
    </Base>
  )
}

export function IconShipping(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <rect x="2" y="7" width="12" height="9" rx="1" />
      <path d="M14 10h4l4 3.5V16h-8z" />
      <circle cx="6.5" cy="18" r="1.7" />
      <circle cx="16.5" cy="18" r="1.7" />
    </Base>
  )
}

export function IconMarketing(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M4 10v4a1 1 0 0 0 1 1h2l5 4V5L7 9H5a1 1 0 0 0-1 1z" />
      <path d="M16 9c1 1 1 5 0 6" />
      <path d="M19 7c2 2 2 8 0 10" />
    </Base>
  )
}

export function IconMail(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3.5 6.5l8.5 6 8.5-6" />
    </Base>
  )
}

export function IconFinance(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <rect x="2" y="6" width="20" height="13" rx="2" />
      <path d="M2 10h20" />
      <path d="M6 15h4" />
    </Base>
  )
}

export function IconSecurity(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M12 3l7 3v6c0 4.5-3 7.7-7 9-4-1.3-7-4.5-7-9V6z" />
      <path d="M9.5 12l1.8 1.8L15 10" />
    </Base>
  )
}

export function IconSystem(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
    </Base>
  )
}

export function IconLogout(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </Base>
  )
}

export function IconChevronLeft(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M15 18l-6-6 6-6" />
    </Base>
  )
}

export function IconChevronRight(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M9 18l6-6-6-6" />
    </Base>
  )
}

export function IconSearch(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M20 20l-4.5-4.5" />
    </Base>
  )
}

export function IconAlert(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M12 3.5L21.5 20h-19z" />
      <path d="M12 9.5v4.5" />
      <circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none" />
    </Base>
  )
}

export function IconInbox(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M3 12l3-8h12l3 8" />
      <path d="M3 12v7a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-7" />
      <path d="M3 12h5l1.5 3h5L16 12h5" />
    </Base>
  )
}

export function IconPlus(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Base>
  )
}

export function IconTag(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M20.59 13.41L13 21l-9-9V4h8l8.59 8.59a2 2 0 0 1 0 2.82z" />
      <circle cx="7.5" cy="7.5" r="1.2" fill="currentColor" stroke="none" />
    </Base>
  )
}

export function IconStar(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M12 3.5l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" />
    </Base>
  )
}

export function IconTree(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M4 4h6v6H4z" />
      <path d="M14 9h6v6h-6z" />
      <path d="M14 4h6v3h-6z" />
      <path d="M10 7h4" />
      <path d="M17 7v2" />
      <path d="M14 17h6v3h-6z" />
      <path d="M17 12v5" />
    </Base>
  )
}

export function IconMoreVertical(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <circle cx="12" cy="5" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="0.8" fill="currentColor" stroke="none" />
    </Base>
  )
}

export function IconTrash(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M4 7h16" />
      <path d="M9 7V4h6v3" />
      <path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </Base>
  )
}
