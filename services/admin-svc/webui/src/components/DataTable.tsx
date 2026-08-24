interface Column {
  key: string
  label: string
}

interface DataTableProps {
  items: Array<Record<string, unknown>> | undefined
  columns: Column[]
}

export function DataTable({ items, columns }: DataTableProps) {
  if (!items || items.length === 0) return <p>Aucune donnée.</p>
  return (
    <table>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.key}>{c.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {items.map((row, i) => (
          <tr key={(row.id as string | number | undefined) ?? i}>
            {columns.map((c) => (
              <td key={c.key}>{String(row[c.key] ?? '')}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
