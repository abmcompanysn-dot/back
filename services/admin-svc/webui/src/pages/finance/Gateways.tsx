import { useEffect, useState } from 'react'
import { ApiError, api } from '../../lib/api'
import { StatusBadge } from '../../components/StatusBadge'
import { FinanceNav } from './FinanceNav'

interface Gateway {
  id: string
  title: string
  method_title: string
  enabled: boolean
}

export function Gateways() {
  const [gateways, setGateways] = useState<Gateway[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<{ gateways: Gateway[] }>('/admin/api/finance/gateways')
      .then((b) => setGateways(b.gateways || []))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'erreur inattendue'))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div>
      <FinanceNav />
      <div className="page-header">
        <div>
          <h2>Passerelles de Paiement</h2>
          <p className="subtitle">Statut des intégrations — clés configurées via variables d'environnement</p>
        </div>
      </div>

      {error && <p className="error-text">{error}</p>}
      {loading && <p>Chargement…</p>}

      {!loading && (
        <div className="table-card">
          <table>
            <thead>
              <tr>
                <th>Passerelle</th>
                <th>Fournisseur</th>
                <th>Statut</th>
              </tr>
            </thead>
            <tbody>
              {gateways.map((g) => (
                <tr key={g.id}>
                  <td className="cell-primary">{g.title}</td>
                  <td className="cell-secondary">{g.method_title}</td>
                  <td>
                    <StatusBadge status={g.enabled ? 'active' : 'down'} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="hint" style={{ marginTop: 12 }}>
        Les clés d'API (Stripe, PayDunya) sont configurées côté serveur (variables d'environnement) et ne
        sont jamais affichées ni modifiables depuis cette interface, pour éviter toute duplication de secret.
      </p>
    </div>
  )
}
