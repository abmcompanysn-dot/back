"use client"

import { useLayoutEffect, useRef, useState, type ImgHTMLAttributes } from 'react'
import Image from 'next/image'
import { cn } from '@/lib/utils'
import { getThumbnailUrl, proxyIfLocalWp } from '@/lib/image-utils'

interface LazyImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  // Toujours une URL (jamais un Blob) — getThumbnailUrl/proxyIfLocalWp
  // n'acceptent que des strings. ImgHTMLAttributes autorise `string | Blob`
  // pour src, ce que LazyImage ne gère jamais : restreint explicitement ici
  // plutôt que de laisser passer un type que le reste du fichier ne
  // supporte pas.
  src?: string
  // Distance avant l'ecran a partir de laquelle l'image commence a charger.
  // Plus grand que le seuil natif du navigateur pour que l'image soit prete
  // avant que l'utilisateur ne l'atteigne en scrollant ou ne clique dessus.
  rootMargin?: string
  // LazyImage n'est utilise que pour des cartes/listes (~110-220px) — jamais
  // pour la grande photo produit de ProductDetail (qui reste en <img> brut) —
  // donc on tente une miniature CDN 300x300 par defaut plutot que l'image en
  // pleine resolution d'origine. Passer thumbnail={false} pour desactiver.
  thumbnail?: boolean
}

function isNearViewport(el: Element, marginPx: number): boolean {
  const rect = el.getBoundingClientRect()
  const vh = window.innerHeight || document.documentElement.clientHeight
  const vw = window.innerWidth || document.documentElement.clientWidth
  return rect.bottom > -marginPx && rect.top < vh + marginPx && rect.right > -marginPx && rect.left < vw + marginPx
}

// ------------------------------------------------------------------
// File d'attente de chargement à concurrence limitée (comme AliExpress/
// Amazon) — ajoutée le 2026-09-03. Avant ça, l'IntersectionObserver de
// chaque LazyImage déclenchait son <img src=...> dès qu'il entrait dans
// rootMargin, sans coordination entre cartes : un scroll rapide sur la
// grille catalogue (des dizaines de cartes en rootMargin d'un coup, encore
// pire à un zoom navigateur réduit qui montre plus de cartes à la fois)
// lançait des dizaines de téléchargements d'images en même temps, et
// beaucoup restaient visuellement vides plusieurs secondes le temps que
// TOUTES finissent — signalé par le fondateur (vidéo du 2026-09-03,
// Pays-Bas) alors même que chaque image individuelle répondait vite au
// serveur. La marge de préchargement n'était pas la cause : le nombre de
// téléchargements lancés EN MÊME TEMPS l'était.
//
// Ici : au plus MAX_CONCURRENT chargements d'image actifs à la fois pour
// TOUTE la page (pas par carte) — les autres candidats attendent en file.
// Une image qui sort du viewport avant d'avoir commencé à charger est
// retirée de la file (cancel), pour ne jamais gaspiller un slot sur une
// carte que l'utilisateur a déjà dépassée en scrollant vite.
const MAX_CONCURRENT = 6
let activeCount = 0
const queue: Array<{ id: symbol; run: () => void }> = []

function requestSlot(id: symbol, run: () => void) {
  if (activeCount < MAX_CONCURRENT) {
    activeCount++
    run()
  } else {
    queue.push({ id, run })
  }
}

function releaseSlot() {
  activeCount = Math.max(0, activeCount - 1)
  const next = queue.shift()
  if (next) {
    activeCount++
    next.run()
  }
}

// Retire une demande encore en file (jamais démarrée) — no-op si elle a
// déjà été promue hors de la file (déjà en cours de chargement, sera
// libérée normalement par releaseSlot au load/erreur).
function cancelQueued(id: symbol) {
  const idx = queue.findIndex((q) => q.id === id)
  if (idx !== -1) queue.splice(idx, 1)
}
// ------------------------------------------------------------------

// 2500px chargeait quasiment toutes les images de la page en même temps
// (dizaines de sections sur l'accueil), saturant les connexions concurrentes
// vers le CDN/origine et laissant des cartes vides plusieurs secondes. Monté
// à 1000px le 2026-07-25 (depuis 600px, demande : les images doivent être
// prêtes avant que le visiteur scrolle jusqu'à elles) — les images servies
// ici sont déjà des miniatures 300x300 pré-générées (getThumbnailUrl), donc
// nettement plus légères que lors du premier réglage à 2500px ; à revoir si
// des cartes vides réapparaissent en scroll rapide.
export function LazyImage({ rootMargin = '1000px 0px', thumbnail = true, src, className, alt, onError, onLoad, ...props }: LazyImageProps) {
  const ref = useRef<HTMLElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const [shouldLoad, setShouldLoad] = useState(false)
  // Un produit jamais passé par `miad.mjs sync` n'a pas de miniature CDN —
  // sa tentative renvoie 404 et on retombe alors sur l'image d'origine.
  // On stocke le src pour lequel l'erreur/le fallback s'est produit plutot
  // qu'un simple booleen : ainsi l'etat s'auto-evince des que `src` change,
  // sans effet dedie pour le reinitialiser.
  const [erroredSrc, setErroredSrc] = useState<string | undefined>(undefined)
  const [originalSrc, setOriginalSrc] = useState<string | undefined>(undefined)
  const errored = erroredSrc === src
  const useOriginal = originalSrc === src

  const effectiveSrc = proxyIfLocalWp(thumbnail && !useOriginal ? getThumbnailUrl(src) : src)

  // Identité stable de cette carte pour la file d'attente — un symbol
  // plutôt que l'index/src évite toute collision si deux cartes partagent
  // temporairement la même image pendant un re-render.
  const slotIdRef = useRef<symbol | undefined>(undefined)
  if (!slotIdRef.current) slotIdRef.current = Symbol('lazy-image-slot')
  const [canStartLoad, setCanStartLoad] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || shouldLoad) return

    // Verification synchrone avant meme de poser l'IntersectionObserver :
    // quand le composant se remonte alors que l'image est deja a l'ecran
    // (ex: on revient sur une page deja visitee), on charge immediatement
    // au lieu d'attendre le premier callback de l'observer (toujours
    // asynchrone), ce qui evitait sinon un flash "image vide puis recharge".
    const marginPx = parseInt(rootMargin, 10) || 0
    if (isNearViewport(el, marginPx)) {
      setShouldLoad(true)
      return
    }

    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setShouldLoad(true)
        observer.disconnect()
      }
    }, { rootMargin })
    observer.observe(el)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootMargin])

  // Une fois éligible (shouldLoad), on ne pose <img src> qu'après avoir
  // obtenu un slot dans la file à concurrence limitée — voir le bloc
  // "File d'attente" plus haut. Si la carte quitte le DOM (scroll rapide
  // qui la démonte, changement de page) avant d'avoir eu son slot, on
  // retire proprement la demande de la file.
  useLayoutEffect(() => {
    if (!shouldLoad || canStartLoad) return
    const id = slotIdRef.current!
    requestSlot(id, () => setCanStartLoad(true))
    return () => cancelQueued(id)
  }, [shouldLoad, canStartLoad])

  // Libère le slot dès que l'image a fini de charger (succès ou échec
  // définitif) pour laisser la suivante en file démarrer — jamais avant,
  // sinon on retomberait sur le même problème de rafale non coordonnée.
  const releasedRef = useRef(false)
  function releaseOnce() {
    if (releasedRef.current) return
    releasedRef.current = true
    releaseSlot()
  }
  useLayoutEffect(() => {
    return () => {
      // Si le composant est démonté avant que l'image n'ait fini de
      // charger (slot déjà accordé), libérer quand même — sinon un slot
      // resterait bloqué indéfiniment par une carte qui a disparu.
      if (canStartLoad) releaseOnce()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Tant que l'image n'a pas encore commence a charger, ou si elle a echoue,
  // on affiche une zone avec le logo MIAD — jamais l'icone "image cassee" du
  // navigateur (ce qui arrivait avec un <img src> vide ou en erreur).
  if (!canStartLoad || errored) {
    return (
      <div ref={ref as any} className={cn('flex items-center justify-center bg-muted', className)}>
        <div className="relative w-1/3 h-1/3">
          <Image src="/logo/logo.png" alt="" fill className="object-contain opacity-30" />
        </div>
      </div>
    )
  }

  return (
    <img
      ref={(node) => {
        (ref as React.RefObject<HTMLImageElement | null>).current = node
        imgRef.current = node
        // Si l'image est deja en cache navigateur (meme URL chargee ailleurs
        // sur la page), le navigateur peut la marquer "complete" avant meme
        // que ce composant n'attache son onLoad — l'evenement 'load' ne se
        // redeclenche pas dans ce cas, laissant l'appelant (ex: squelette de
        // chargement) bloque indefiniment alors que l'image est deja
        // affichee. On verifie donc `complete` explicitement des le montage.
        if (node && node.complete && node.naturalWidth > 0) {
          releaseOnce()
          onLoad?.({ currentTarget: node } as React.SyntheticEvent<HTMLImageElement, Event>)
        }
      }}
      src={effectiveSrc}
      alt={alt}
      className={className}
      onLoad={(e) => { releaseOnce(); onLoad?.(e) }}
      onError={(e) => {
        // La miniature CDN a échoué (produit jamais synchronisé) : on retente
        // une fois avec l'originale avant d'abandonner à l'icône de secours.
        if (effectiveSrc !== src && !useOriginal) {
          setOriginalSrc(src)
          return
        }
        releaseOnce()
        setErroredSrc(src)
        onError?.(e)
      }}
      {...props}
    />
  )
}
