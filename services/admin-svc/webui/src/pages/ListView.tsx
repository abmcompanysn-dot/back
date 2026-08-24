import { useApiData } from '../lib/useApiData'
import { DataTable } from '../components/DataTable'

interface ListResponse {
  items?: Array<Record<string, unknown>>
}

interface ListViewProps {
  path: string
  columns: Array<{ key: string; label: string }>
}

export function ListView({ path, columns }: ListViewProps) {
  const { data, error, loading } = useApiData<ListResponse>(path)
  if (loading) return <p>Chargement…</p>
  if (error) return <p className="error-text">Erreur : {error}</p>
  return <DataTable items={data?.items} columns={columns} />
}

export const ORDER_COLUMNS = [
  { key: 'id', label: 'id' },
  { key: 'reference', label: 'reference' },
  { key: 'vendor_id', label: 'vendor_id' },
  { key: 'status', label: 'status' },
  { key: 'total_usd', label: 'total_usd' },
  { key: 'created_at', label: 'created_at' },
]

export const PRODUCT_COLUMNS = [
  { key: 'id', label: 'id' },
  { key: 'name', label: 'name' },
  { key: 'vendor_id', label: 'vendor_id' },
  { key: 'price', label: 'price' },
  { key: 'lang', label: 'lang' },
]

export const VENDOR_COLUMNS = [
  { key: 'id', label: 'id' },
  { key: 'name', label: 'name' },
  { key: 'country', label: 'country' },
  { key: 'city', label: 'city' },
  { key: 'rating_avg', label: 'rating_avg' },
  { key: 'product_count', label: 'product_count' },
]

export const CUSTOMER_COLUMNS = [
  { key: 'id', label: 'id' },
  { key: 'email', label: 'email' },
  { key: 'phone', label: 'phone' },
  { key: 'preferred_lang', label: 'preferred_lang' },
  { key: 'created_at', label: 'created_at' },
]

export const PAYMENT_COLUMNS = [
  { key: 'id', label: 'id' },
  { key: 'order_id', label: 'order_id' },
  { key: 'provider', label: 'provider' },
  { key: 'status', label: 'status' },
  { key: 'amount_usd', label: 'amount_usd' },
  { key: 'created_at', label: 'created_at' },
]
