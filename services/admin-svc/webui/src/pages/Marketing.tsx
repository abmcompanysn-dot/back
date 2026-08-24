import { EmptyState } from '../components/EmptyState'
import { IconMarketing } from '../components/Icons'

// Placeholder — coupons/fidélité (loyalty-svc) + tracking publicitaire
// (GTM/Meta Pixel/GA/flux catalogue Shopping) arrivent dans une étape
// dédiée du plan, pas encore construits.
export function Marketing() {
  return (
    <div>
      <div className="page-header">
        <div>
          <h2>Marketing</h2>
          <p className="subtitle">Coupons, fidélité, tracking publicitaire</p>
        </div>
      </div>
      <EmptyState
        icon={<IconMarketing width={40} height={40} strokeWidth={1.4} />}
        title="Module Marketing à venir"
        description="Coupons & promotions, programme de fidélité, et pixels de tracking (GTM, Meta Pixel, Google Analytics, flux Shopping) arriveront ici."
      />
    </div>
  )
}
