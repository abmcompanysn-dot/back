"use client"

import { useLayoutEffect, useRef, useState, type ImgHTMLAttributes } from 'react'
import Image from 'next/image'
import { cn } from '@/lib/utils'
import { getThumbnailUrl, proxyIfLocalWp } from '@/lib/image-utils'

interface LazyImageProps extends ImgHTMLAttributes<HTMLImageElement> {
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

  // Tant que l'image n'a pas encore commence a charger, ou si elle a echoue,
  // on affiche une zone avec le logo MIAD — jamais l'icone "image cassee" du
  // navigateur (ce qui arrivait avec un <img src> vide ou en erreur).
  if (!shouldLoad || errored) {
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
          onLoad?.({ currentTarget: node } as React.SyntheticEvent<HTMLImageElement, Event>)
        }
      }}
      src={effectiveSrc}
      alt={alt}
      className={className}
      onLoad={onLoad}
      onError={(e) => {
        // La miniature CDN a échoué (produit jamais synchronisé) : on retente
        // une fois avec l'originale avant d'abandonner à l'icône de secours.
        if (effectiveSrc !== src && !useOriginal) {
          setOriginalSrc(src)
          return
        }
        setErroredSrc(src)
        onError?.(e)
      }}
      {...props}
    />
  )
}
