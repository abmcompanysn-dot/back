import { useEffect, useRef } from 'react'

// RichTextEditor — éditeur enrichi minimal (Gras, Italique, Liste à
// puces, Lien) pour la description détaillée produit, sans dépendance
// externe (cohérent avec le reste du webui admin : JWT signé à la main,
// TOTP en Go pur…). Revue UX 2026-09-02 : la zone était une <textarea>
// brute, sans mise en forme possible.
//
// Compatible avec le rendu public (ProductDetail.tsx sanitizedDescription) :
// celui-ci détecte automatiquement du HTML (balises p/strong/em/ul/li) et
// l'affiche tel quel — ce composant produit exactement ce sous-ensemble de
// balises via document.execCommand, donc aucune migration du contenu
// existant n'est nécessaire (le texte brut historique, sans balise,
// continue d'emprunter l'ancien chemin de mise en forme automatique).

interface Props {
  value: string
  onChange: (html: string) => void
  placeholder?: string
  rows?: number
}

export function RichTextEditor({ value, onChange, placeholder, rows = 8 }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const lastValue = useRef<string>('')

  // Ne réécrit le DOM que si `value` a changé depuis l'EXTÉRIEUR (ex.
  // chargement initial de la fiche) — sinon chaque frappe de l'utilisateur
  // ferait perdre la position du curseur (le parent re-render avec la
  // même valeur que celle qu'on vient de lui envoyer).
  useEffect(() => {
    if (ref.current && value !== lastValue.current) {
      ref.current.innerHTML = value || ''
      lastValue.current = value || ''
    }
  }, [value])

  function emit() {
    if (!ref.current) return
    const html = ref.current.innerHTML
    lastValue.current = html
    onChange(html)
  }

  function exec(cmd: string, arg?: string) {
    ref.current?.focus()
    document.execCommand(cmd, false, arg)
    emit()
  }

  function insertLink() {
    const url = window.prompt('URL du lien :')
    if (url) exec('createLink', url)
  }

  return (
    <div className="rte">
      <div className="rte-toolbar">
        <button type="button" title="Gras" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('bold')}>
          <b>G</b>
        </button>
        <button type="button" title="Italique" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('italic')}>
          <i>I</i>
        </button>
        <button
          type="button"
          title="Liste à puces"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => exec('insertUnorderedList')}
        >
          • Liste
        </button>
        <button type="button" title="Lien" onMouseDown={(e) => e.preventDefault()} onClick={insertLink}>
          🔗 Lien
        </button>
        <button
          type="button"
          title="Effacer la mise en forme"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => exec('removeFormat')}
        >
          Effacer
        </button>
      </div>
      <div
        ref={ref}
        className="rte-content"
        style={{ minHeight: rows * 22 }}
        contentEditable
        suppressContentEditableWarning
        onInput={emit}
        onBlur={emit}
        data-placeholder={placeholder}
      />
    </div>
  )
}
