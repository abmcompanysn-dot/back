# Rapport Technique MIAD Market — Code Review
**Date** : 2026-06-10  
**Périmètre** : Changements des 3 derniers commits (navigation boutiques, refonte page d'accueil, FlashSalesSection)

---

## ✅ Ce qui a été fait

| # | Fichier | Changement |
|---|---------|------------|
| 1 | `components/miad/HomePage.tsx` | **Boutiques Officielles** déplacée tout en haut (avant le Hero) |
| 2 | `components/miad/HomePage.tsx` | Ordre des sections : Boutiques → Hero → Tickets → Flash → Prix réduits → Catégories → Promo → Sponsorisées → Pays → CTA |
| 3 | `components/miad/FlashSalesSection.tsx` | Section rendue compacte (style LIVE AliExpress) avec badge rouge animé, cartes 28px |
| 4 | `app/MiadMarketClient.tsx` | Navigation boutique via SPA instantanée (plus de `router.push` qui causait une page blanche) |

---

## 🔴 Bugs Critiques (à corriger immédiatement)

### BUG 1 — Navigation boutique→boutique cassée
**Fichier** : `app/MiadMarketClient.tsx` ligne ~289  
**Problème** : La fonction `navigateTo` contient un guard `if (view === currentView) return`. Si l'utilisateur est déjà sur une page boutique et clique sur une autre boutique, la fonction retourne immédiatement sans rien faire. La boutique reste bloquée sur l'ancienne.  
**Scénario** : Utilisateur sur "Boutique A" → clique sur "Boutique B" → la page reste sur "Boutique A".  
**Fix appliqué** : Utilisation d'un compteur `vendorKey` pour forcer le remontage.

### BUG 2 — Cache produits boutique contaminé entre boutiques
**Fichier** : `app/VendorStorePage.tsx` ligne ~45  
**Problème** : La ref `cachedProducts` garde les produits de la boutique précédente quand on navigue boutique→boutique (le composant ne se démonte pas). L'utilisateur voit les produits de la mauvaise boutique le temps que l'API réponde.  
**Fix appliqué** : Reset de la ref quand `vendor.id` change.

### BUG 3 — "Voir tout" dans Boutiques Sponsorisées ne fonctionne pas
**Fichier** : `components/miad/HomePage.tsx` ligne ~267  
**Problème** : `onNavigate('stores')` appelle une vue inexistante. Le type `View` n'a pas `'stores'`, il a `'storesList'`. Résultat : page skeleton infinie.  
**Fix appliqué** : Corrigé en `'storesList'`.

### BUG 4 — Produits vides à l'ouverture d'une boutique  
**Fichier** : `app/VendorStorePage.tsx` ligne ~26  
**Problème** : Le filtre `String(p.vendor?.id) === String(vendor.id)` peut retourner 0 résultats si les produits n'ont pas leur `vendor.id` renseigné (import WooCommerce sans ID numérique). Déclenche un fetch API inutile + skeleton visible.  
**Fix appliqué** : Filtre enrichi avec fallback par `vendor.name` et `vendor.slug`.

---

## 🟡 Problèmes Significatifs (non bloquants)

### ISSUE 5 — Layout Shift (CLS) quand les boutiques chargent
**Fichier** : `components/miad/HomePage.tsx`  
**Problème** : `TopVendorsStrip` retourne `null` tant que `stores` est vide. Quand les données arrivent (~300ms), la section apparaît et pousse le Hero vers le bas. L'utilisateur voit un saut de layout.  
**Recommandation** : Ajouter un skeleton placeholder de hauteur fixe pendant le chargement des boutiques.

### ISSUE 6 — URLs boutiques non partagéables  
**Fichier** : `app/MiadMarketClient.tsx`  
**Problème** : La navigation SPA ne met pas à jour l'URL vers `/vendor/slug` (intentionnel — évite que Next.js intercepte et démonte le SPA). Conséquence : copier-coller l'URL ramène sur la homepage, pas sur la boutique.  
**Recommandation** : Utiliser `window.history.replaceState` (pas pushState) avec l'URL boutique APRÈS que la vue 'store' est montée, pour que Next.js ne détecte pas le changement pendant la navigation.

### ISSUE 7 — Données produits boutique non pré-chargées (SSR perdu)
**Fichier** : `app/vendor/[slug]/page.tsx` + `app/VendorStorePage.tsx`  
**Problème** : L'ancienne navigation `router.push('/vendor/slug')` utilisait la page SSR qui pré-fetche les produits côté serveur (0 latence). La navigation SPA actuelle déclenche un `useSWR` client-side visible.  
**Impact** : Sur connexion lente, l'utilisateur voit un skeleton de ~1-2 secondes pour les produits.  
**Recommandation** : Ajouter un prefetch de produits au survol (hover) de la boutique dans `TopVendorsStrip`.

---

## 🟢 Améliorations suggérées

### A — Prefetch au survol des boutiques
```tsx
// Dans TopVendorsStrip, ajouter onMouseEnter
<button
  onMouseEnter={() => {
    // Précharger silencieusement les produits de cette boutique
    fetch(`/api/products?vendor=${store.id}&per_page=20`)
  }}
  onClick={() => onStoreClick(store)}
>
```

### B — Skeleton fixe pour éviter le CLS
Remplacer `if (stores.length === 0) return null` par un skeleton de hauteur fixe (96px) pour éviter le saut de layout quand les boutiques chargent.

### C — URL boutique après montage
Utiliser `replaceState` après montage de la vue store pour mettre l'URL à jour sans déclencher Next.js :
```javascript
// Dans VendorStorePage, après le premier render
useEffect(() => {
  if (vendor.slug) {
    window.history.replaceState(null, '', `/vendor/${vendor.slug}`)
  }
}, [vendor.slug])
```

### D — Correspondance produits multi-critères
Le filtre actuel `p.vendor?.id === vendor.id` est fragile. Utiliser un filtre multi-critères (ID + slug + nom) pour maximiser les matches locaux et éviter les fetches API inutiles.

### E — Nettoyage du `router` inutilisé
`const router = useRouter()` reste dans `MiadMarketClient.tsx` mais n'est plus utilisé dans `handleVendorClick`. Le supprimer si aucun autre endroit ne l'utilise.

---

## 📊 Score de qualité par fichier

| Fichier | État | Score |
|---------|------|-------|
| `components/miad/FlashSalesSection.tsx` | ✅ Propre | 9/10 |
| `components/miad/HomePage.tsx` | ⚠️ Bug 3 corrigé | 7/10 |
| `app/MiadMarketClient.tsx` | ⚠️ Bug 1 corrigé | 7/10 |
| `app/VendorStorePage.tsx` | ⚠️ Bugs 2,4 corrigés | 6/10 |

---

*Rapport généré par `/code-review` — Claude Sonnet 4.6*
