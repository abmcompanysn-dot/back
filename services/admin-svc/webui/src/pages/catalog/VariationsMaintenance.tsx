import { useState } from 'react'
import { ApiError, api } from '../../lib/api'
import { CatalogNav } from './CatalogNav'

// Deux opérations de maintenance sur les variations produit, chacune avec
// un aperçu (dry-run) affiché en tableau AVANT toute modification :
//
//  1. Réparer les "faux variables" — produits marqués variables mais avec
//     une seule variation (sélecteur inutile / bouton "Choisir" en
//     cul-de-sac, cf. vidéos du 2026-08-28). → repassés en produit simple.
//  2. Générer les pointures 36→46 sur les chaussures existantes qui n'ont
//     pas encore de variation de taille.

interface CollapseDetail {
  product_id: number
  name: string
  new_price_usd: number
  new_stock: number
  removed_variation_id: number
  removed_attributes: Record<string, unknown>
}
interface CollapseResult {
  dry_run: boolean
  candidates: number
  products_collapsed: number
  details: CollapseDetail[]
}

interface ShoeDetail {
  product_id: number
  name: string
  price_usd: number
  stock_per_size: number
  sizes: string[]
}
interface ShoeResult {
  dry_run: boolean
  shoe_categories: number
  products_scanned: number
  products_updated: number
  products_skipped: number
  variations_created: number
  size_grid: string[]
  attribute: string
  details: ShoeDetail[]
  note?: string
}

export function VariationsMaintenance() {
  const [error, setError] = useState<string | null>(null)

  // --- Faux variables ---
  const [collapsePreview, setCollapsePreview] = useState<CollapseResult | null>(null)
  const [collapseDone, setCollapseDone] = useState<CollapseResult | null>(null)
  const [collapseBusy, setCollapseBusy] = useState(false)

  async function runCollapse(dryRun: boolean) {
    setCollapseBusy(true)
    setError(null)
    try {
      const res = await api.post<CollapseResult>(
        `/admin/api/catalog/collapse-fake-variables${dryRun ? '?dry_run=true' : ''}`
      )
      if (dryRun) {
        setCollapsePreview(res)
        setCollapseDone(null)
      } else {
        setCollapseDone(res)
        setCollapsePreview(null)
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec de l\'opération')
    } finally {
      setCollapseBusy(false)
    }
  }

  // --- Pointures chaussures ---
  const [shoePreview, setShoePreview] = useState<ShoeResult | null>(null)
  const [shoeDone, setShoeDone] = useState<ShoeResult | null>(null)
  const [shoeBusy, setShoeBusy] = useState(false)

  async function runShoe(dryRun: boolean) {
    setShoeBusy(true)
    setError(null)
    try {
      const res = await api.post<ShoeResult>(
        `/admin/api/catalog/backfill-shoe-sizes${dryRun ? '?dry_run=true' : ''}`
      )
      if (dryRun) {
        setShoePreview(res)
        setShoeDone(null)
      } else {
        setShoeDone(res)
        setShoePreview(null)
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec de l\'opération')
    } finally {
      setShoeBusy(false)
    }
  }

  // --- Tailles vêtements (même forme de réponse que les pointures) ---
  const [clothPreview, setClothPreview] = useState<ShoeResult | null>(null)
  const [clothDone, setClothDone] = useState<ShoeResult | null>(null)
  const [clothBusy, setClothBusy] = useState(false)

  async function runCloth(dryRun: boolean) {
    setClothBusy(true)
    setError(null)
    try {
      const res = await api.post<ShoeResult>(
        `/admin/api/catalog/backfill-clothing-sizes${dryRun ? '?dry_run=true' : ''}`
      )
      if (dryRun) {
        setClothPreview(res)
        setClothDone(null)
      } else {
        setClothDone(res)
        setClothPreview(null)
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'échec de l\'opération')
    } finally {
      setClothBusy(false)
    }
  }

  return (
    <div>
      <CatalogNav />
      <div className="page-header">
        <div>
          <h2>Maintenance des variations</h2>
          <p className="subtitle">
            Réparer les fiches produit dont les variations empêchent l'achat, et générer les pointures
            manquantes sur les chaussures.
          </p>
        </div>
      </div>

      {error && <p className="error-text">{error}</p>}

      {/* ------------------------------------------------------------ */}
      {/* 1. Faux variables                                            */}
      {/* ------------------------------------------------------------ */}
      <div className="form-card" style={{ marginBottom: 20 }}>
        <h3 style={{ marginTop: 0 }}>1. Réparer les produits « faux variables »</h3>
        <p className="hint">
          Un produit marqué « variable » mais qui n'a en réalité qu'<strong>une seule variation</strong>
          affiche un sélecteur inutile (un seul bouton), voire un bouton « Choisir » sans rien à choisir
          — le client ne peut alors pas acheter. Cette opération repasse ces produits en « simple » :
          le prix et le stock de l'unique variation sont recopiés sur le produit, puis la variation est
          supprimée.
        </p>

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn-ghost" disabled={collapseBusy} onClick={() => runCollapse(true)}>
            {collapseBusy ? '…' : 'Aperçu (ne modifie rien)'}
          </button>
          {collapsePreview && collapsePreview.candidates > 0 && (
            <button
              className="btn-danger"
              disabled={collapseBusy}
              onClick={() => {
                if (
                  confirm(
                    `Repasser ${collapsePreview.candidates} produit(s) en « simple » ? Les variations uniques seront supprimées. Action irréversible.`
                  )
                ) {
                  runCollapse(false)
                }
              }}
            >
              Appliquer sur {collapsePreview.candidates} produit(s)
            </button>
          )}
        </div>

        {collapseDone && (
          <p className="hint" style={{ marginTop: 12, color: '#1a7f37' }}>
            ✓ {collapseDone.products_collapsed} produit(s) repassé(s) en « simple ».
          </p>
        )}

        {collapsePreview && (
          <div style={{ marginTop: 12 }}>
            <p className="hint">
              {collapsePreview.candidates} produit(s) concerné(s).
            </p>
            {collapsePreview.candidates > 0 && (
              <div className="table-card" style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Produit</th>
                      <th>Nouveau prix (USD)</th>
                      <th>Nouveau stock</th>
                      <th>Variation supprimée</th>
                      <th>Attributs supprimés</th>
                    </tr>
                  </thead>
                  <tbody>
                    {collapsePreview.details.map((d) => (
                      <tr key={d.product_id}>
                        <td>{d.product_id}</td>
                        <td>{d.name}</td>
                        <td>{d.new_price_usd}</td>
                        <td>{d.new_stock}</td>
                        <td>#{d.removed_variation_id}</td>
                        <td>
                          <code style={{ fontSize: 11 }}>{JSON.stringify(d.removed_attributes)}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ------------------------------------------------------------ */}
      {/* 2. Pointures chaussures                                      */}
      {/* ------------------------------------------------------------ */}
      <div className="form-card">
        <h3 style={{ marginTop: 0 }}>2. Générer les pointures des chaussures</h3>
        <p className="hint">
          Parcourt les produits des catégories « chaussures » (chaussure, sandale, babouche, basket,
          mocassin, botte…) et, pour chacun sans variation de taille, crée la grille EU 36→46 sous
          l'attribut « Pointure ». Chaque pointure reprend le prix et le stock du produit.
        </p>

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn-ghost" disabled={shoeBusy} onClick={() => runShoe(true)}>
            {shoeBusy ? '…' : 'Aperçu (ne modifie rien)'}
          </button>
          {shoePreview && shoePreview.products_updated > 0 && (
            <button
              className="btn-primary"
              disabled={shoeBusy}
              onClick={() => {
                if (
                  confirm(
                    `Générer les pointures 36→46 sur ${shoePreview.products_updated} produit(s) ? (${shoePreview.variations_created} variations créées)`
                  )
                ) {
                  runShoe(false)
                }
              }}
            >
              Appliquer sur {shoePreview.products_updated} produit(s)
            </button>
          )}
        </div>

        {shoeDone && (
          <p className="hint" style={{ marginTop: 12, color: '#1a7f37' }}>
            ✓ {shoeDone.products_updated} produit(s) mis à jour, {shoeDone.variations_created} pointures
            créées ({shoeDone.products_skipped} déjà avec une taille, ignorés).
          </p>
        )}

        {shoePreview && (
          <div style={{ marginTop: 12 }}>
            <p className="hint">
              {shoePreview.shoe_categories} catégorie(s) chaussures · {shoePreview.products_scanned}{' '}
              produit(s) scanné(s) · {shoePreview.products_updated} à traiter ·{' '}
              {shoePreview.products_skipped} déjà OK.
              {shoePreview.note && <> — {shoePreview.note}</>}
            </p>
            {shoePreview.products_updated > 0 && (
              <div className="table-card" style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Produit</th>
                      <th>Prix (USD)</th>
                      <th>Stock / pointure</th>
                      <th>Pointures créées</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shoePreview.details.map((d) => (
                      <tr key={d.product_id}>
                        <td>{d.product_id}</td>
                        <td>{d.name}</td>
                        <td>{d.price_usd}</td>
                        <td>{d.stock_per_size}</td>
                        <td>{d.sizes.join(', ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ------------------------------------------------------------ */}
      {/* 3. Tailles vêtements (homme + femme)                         */}
      {/* ------------------------------------------------------------ */}
      <div className="form-card" style={{ marginTop: 20 }}>
        <h3 style={{ marginTop: 0 }}>3. Générer les tailles des vêtements (homme &amp; femme)</h3>
        <p className="hint">
          Parcourt les produits des catégories « vêtements » homme et femme (vêtement, homme, femme,
          robe, boubou, ensemble, chemise, pantalon…) — <strong>hors enfant, sacs, pagnes et
          chaussures</strong> — et, pour chacun sans variation de taille, crée la grille
          <strong> S / M / L / XL / XXL / XXXL</strong> sous l'attribut « Taille ». Chaque taille
          reprend le prix et le stock du produit.
        </p>

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn-ghost" disabled={clothBusy} onClick={() => runCloth(true)}>
            {clothBusy ? '…' : 'Aperçu (ne modifie rien)'}
          </button>
          {clothPreview && clothPreview.products_updated > 0 && (
            <button
              className="btn-primary"
              disabled={clothBusy}
              onClick={() => {
                if (
                  confirm(
                    `Générer les tailles S→XXXL sur ${clothPreview.products_updated} produit(s) ? (${clothPreview.variations_created} variations créées)`
                  )
                ) {
                  runCloth(false)
                }
              }}
            >
              Appliquer sur {clothPreview.products_updated} produit(s)
            </button>
          )}
        </div>

        {clothDone && (
          <p className="hint" style={{ marginTop: 12, color: '#1a7f37' }}>
            ✓ {clothDone.products_updated} produit(s) mis à jour, {clothDone.variations_created} tailles
            créées ({clothDone.products_skipped} déjà avec une taille, ignorés).
          </p>
        )}

        {clothPreview && (
          <div style={{ marginTop: 12 }}>
            <p className="hint">
              {clothPreview.shoe_categories} catégorie(s) vêtements · {clothPreview.products_scanned}{' '}
              produit(s) scanné(s) · {clothPreview.products_updated} à traiter ·{' '}
              {clothPreview.products_skipped} déjà OK.
              {clothPreview.note && <> — {clothPreview.note}</>}
            </p>
            {clothPreview.products_updated > 0 && (
              <div className="table-card" style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Produit</th>
                      <th>Prix (USD)</th>
                      <th>Stock / taille</th>
                      <th>Tailles créées</th>
                    </tr>
                  </thead>
                  <tbody>
                    {clothPreview.details.map((d) => (
                      <tr key={d.product_id}>
                        <td>{d.product_id}</td>
                        <td>{d.name}</td>
                        <td>{d.price_usd}</td>
                        <td>{d.stock_per_size}</td>
                        <td>{d.sizes.join(', ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
