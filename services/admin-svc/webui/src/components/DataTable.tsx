import { useMemo, useState, type ReactNode } from 'react'
import { EmptyState } from './EmptyState'
import { StatusBadge } from './StatusBadge'
import { IconSearch } from './Icons'

interface Column {
  key: string
  label: string
  /** rend la valeur comme un badge de statut coloré plutôt qu'en texte brut */
  badge?: boolean
}

interface RowAction {
  label: string
  onClick: (row: Record<string, unknown>) => void
}

interface DataTableProps {
  items: Array<Record<string, unknown>> | undefined
  columns: Column[]
  emptyIcon?: ReactNode
  emptyTitle?: string
  emptyDescription?: string
  rowActions?: RowAction[]
  pageSizeOptions?: number[]
}

const PAGE_SIZES = [10, 25, 50]

export function DataTable({
  items,
  columns,
  emptyIcon,
  emptyTitle = 'Aucune donnée pour le moment',
  emptyDescription,
  rowActions,
  pageSizeOptions = PAGE_SIZES,
}: DataTableProps) {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(pageSizeOptions[0])

  const filtered = useMemo(() => {
    if (!items) return []
    if (!query.trim()) return items
    const q = query.toLowerCase()
    return items.filter((row) => Object.values(row).some((v) => String(v ?? '').toLowerCase().includes(q)))
  }, [items, query])

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(page, totalPages)
  const pageItems = filtered.slice((safePage - 1) * pageSize, safePage * pageSize)

  if (!items || items.length === 0) {
    return <EmptyState icon={emptyIcon} title={emptyTitle} description={emptyDescription} />
  }

  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        <input
          className="search-input"
          placeholder="Rechercher…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setPage(1)
          }}
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<IconSearch width={40} height={40} strokeWidth={1.4} />}
          title="Aucun résultat"
          description="Essayez un autre terme de recherche."
        />
      ) : (
        <div className="table-card">
          <table>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.key}>{c.label}</th>
                ))}
                {rowActions && rowActions.length > 0 && <th></th>}
              </tr>
            </thead>
            <tbody>
              {pageItems.map((row, i) => (
                <tr key={(row.id as string | number | undefined) ?? i}>
                  {columns.map((c) =>
                    c.badge ? (
                      <td key={c.key}>
                        <StatusBadge status={row[c.key] as string | undefined} />
                      </td>
                    ) : (
                      <td key={c.key}>{String(row[c.key] ?? '')}</td>
                    ),
                  )}
                  {rowActions && rowActions.length > 0 && (
                    <td>
                      <div className="row-actions">
                        {rowActions.map((a) => (
                          <button key={a.label} onClick={() => a.onClick(row)}>
                            {a.label}
                          </button>
                        ))}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>

          <div className="table-pagination">
            <span>
              {filtered.length} résultat{filtered.length > 1 ? 's' : ''}
            </span>
            <div className="page-controls">
              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value))
                  setPage(1)
                }}
              >
                {pageSizeOptions.map((n) => (
                  <option key={n} value={n}>
                    {n} / page
                  </option>
                ))}
              </select>
              <button disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>
                ‹
              </button>
              <span>
                {safePage} / {totalPages}
              </span>
              <button disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)}>
                ›
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
