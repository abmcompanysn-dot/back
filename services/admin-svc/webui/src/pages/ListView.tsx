import type { ReactNode } from 'react'
import { useApiData } from '../lib/useApiData'
import { DataTable } from '../components/DataTable'
import { EmptyState } from '../components/EmptyState'
import { IconAlert } from '../components/Icons'

interface ListResponse {
  items?: Array<Record<string, unknown>>
}

interface Column {
  key: string
  label: string
  badge?: boolean
}

interface ListViewProps {
  path: string
  columns: Column[]
  title?: string
  subtitle?: string
  emptyIcon?: ReactNode
  emptyTitle?: string
  emptyDescription?: string
}

export function ListView({ path, columns, title, subtitle, emptyIcon, emptyTitle, emptyDescription }: ListViewProps) {
  const { data, error, loading } = useApiData<ListResponse>(path)

  return (
    <div>
      {title && (
        <div className="page-header">
          <div>
            <h2>{title}</h2>
            {subtitle && <p className="subtitle">{subtitle}</p>}
          </div>
        </div>
      )}

      {loading && <p>Chargement…</p>}
      {error && (
        <EmptyState
          icon={<IconAlert width={40} height={40} strokeWidth={1.4} />}
          title="Impossible de charger les données"
          description={error}
        />
      )}
      {!loading && !error && (
        <DataTable
          items={data?.items}
          columns={columns}
          emptyIcon={emptyIcon}
          emptyTitle={emptyTitle}
          emptyDescription={emptyDescription}
        />
      )}
    </div>
  )
}

export const ORDER_COLUMNS: Column[] = [
  { key: 'id', label: 'id' },
  { key: 'reference', label: 'reference' },
  { key: 'vendor_id', label: 'vendor_id' },
  { key: 'status', label: 'status', badge: true },
  { key: 'total_usd', label: 'total_usd' },
  { key: 'created_at', label: 'created_at' },
]

export const VENDOR_COLUMNS: Column[] = [
  { key: 'id', label: 'id' },
  { key: 'name', label: 'name' },
  { key: 'country', label: 'country' },
  { key: 'city', label: 'city' },
  { key: 'rating_avg', label: 'rating_avg' },
  { key: 'product_count', label: 'product_count' },
]

export const CUSTOMER_COLUMNS: Column[] = [
  { key: 'id', label: 'id' },
  { key: 'email', label: 'email' },
  { key: 'phone', label: 'phone' },
  { key: 'preferred_lang', label: 'preferred_lang' },
  { key: 'created_at', label: 'created_at' },
]

export const PAYMENT_COLUMNS: Column[] = [
  { key: 'id', label: 'id' },
  { key: 'order_id', label: 'order_id' },
  { key: 'provider', label: 'provider' },
  { key: 'status', label: 'status', badge: true },
  { key: 'amount_usd', label: 'amount_usd' },
  { key: 'created_at', label: 'created_at' },
]
