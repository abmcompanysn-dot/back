import { EmptyState } from '../../components/EmptyState'
import { IconTree } from '../../components/Icons'
import { CatalogNav } from './CatalogNav'

// Prochaine étape du module Catalogue : arbre hiérarchique drag & drop,
// commission par catégorie (colonne commission_rate déjà en place côté
// catalog-svc), types d'attributs + valeurs (tables attributes/attribute_values
// déjà créées, endpoints à ajouter).
export function CategoriesAttributes() {
  return (
    <div>
      <CatalogNav />
      <div className="page-header">
        <div>
          <h2>Catégories &amp; Attributs</h2>
          <p className="subtitle">Arborescence des catégories et spécifications produit</p>
        </div>
      </div>
      <EmptyState
        icon={<IconTree width={40} height={40} strokeWidth={1.4} />}
        title="Gestion des catégories & attributs — à venir"
        description="Arbre hiérarchique, réordonnancement, commission par catégorie et types d'attributs (couleur, taille…) arriveront dans une prochaine étape."
      />
    </div>
  )
}
