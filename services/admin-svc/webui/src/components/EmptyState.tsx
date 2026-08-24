import type { ReactNode } from 'react'
import { IconInbox } from './Icons'

interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description?: string
  action?: { label: string; onClick: () => void }
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon ?? <IconInbox width={40} height={40} strokeWidth={1.4} />}</div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action && (
        <button className="btn-primary" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  )
}
