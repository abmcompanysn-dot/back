import { EmptyState } from '../components/EmptyState'
import { IconShipping } from '../components/Icons'

export function Shipping() {
  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Livraison</h2>
          <p className="subtitle">Zones, tarifs et transporteurs (DHL, national Sénégal)</p>
        </div>
      </div>
      <EmptyState
        icon={<IconShipping width={40} height={40} strokeWidth={1.4} />}
        title="Devis interactif à venir"
        description="Le simulateur de tarifs par zone (international + national Sénégal) sera intégré ici."
      />
    </div>
  )
}
