import { EmptyState } from '../../components/EmptyState'
import { IconStar } from '../../components/Icons'
import { CatalogNav } from './CatalogNav'

// Prochaine étape : liste paginée (GET /products/{id}/reviews existe déjà
// par produit côté catalog-svc, il manque une liste globale tous produits
// confondus + les actions de modération PATCH status approved/rejected).
export function Reviews() {
  return (
    <div>
      <CatalogNav />
      <div className="page-header">
        <div>
          <h2>Avis &amp; Modération</h2>
          <p className="subtitle">Réputation des produits et retours clients</p>
        </div>
      </div>
      <EmptyState
        icon={<IconStar width={40} height={40} strokeWidth={1.4} />}
        title="Modération des avis — à venir"
        description="Liste des avis clients, notes et actions d'approbation/rejet arriveront dans une prochaine étape."
      />
    </div>
  )
}
