/* ============================================================
   Données d'audit — relevées directement dans le projet
   « sandbox-workspace », sans aucune modification appliquée.
   ============================================================ */

export type Tone = "ok" | "warn" | "alert" | "info" | "neutral";

export const PROJECT = {
  name: "sandbox-workspace",
  ref: "AUDIT-2026-014",
  date: "février 2026",
  mode: "Lecture seule",
  score: 62,
  verdict: "Fondations saines — application à construire",
  filesAnalyzed: 8,
  totalLines: 183,
  srcLines: 15,
  prodDeps: 13,
  devDeps: 9,
  depsImported: 0,
};

export const NAV = [
  { id: "synthese", num: "01", label: "Synthèse" },
  { id: "stack", num: "02", label: "Stack technique" },
  { id: "fichiers", num: "03", label: "Fichiers & arborescence" },
  { id: "dependances", num: "04", label: "Dépendances" },
  { id: "constats", num: "05", label: "Constats" },
  { id: "terminal", num: "06", label: "Journal d'analyse" },
  { id: "recommandations", num: "07", label: "Recommandations" },
  { id: "verdict", num: "08", label: "Verdict & méthode" },
] as const;

export const COUNTERS = [
  { value: 8, suffix: "", label: "fichiers analysés", tone: "info" },
  { value: 183, suffix: "", label: "lignes lues au total", tone: "info" },
  { value: 13, suffix: "", label: "dépendances de production", tone: "neutral" },
  { value: 0, suffix: "", label: "réellement importée dans src/", tone: "warn" },
  { value: 15, suffix: "", label: "lignes de code applicatif", tone: "warn" },
  { value: 100, suffix: " %", label: "du projet laissé intact", tone: "ok" },
] as const;

export const SUBSCORES: { label: string; value: number; tone: Tone; note: string }[] = [
  {
    label: "Infrastructure & build",
    value: 88,
    tone: "ok",
    note: "Vite 6 + plugin Tailwind v4, script typecheck, instrumentation sandbox.",
  },
  {
    label: "Configuration TypeScript",
    value: 81,
    tone: "ok",
    note: "strict: true, moduleResolution bundler — mais config Vite en .js et options de garde absentes.",
  },
  {
    label: "Hygiène des dépendances",
    value: 55,
    tone: "warn",
    note: "13 dépendances installées, aucune importée ; Font Awesome chargé en CDN sans usage.",
  },
  {
    label: "Code applicatif",
    value: 12,
    tone: "alert",
    note: "App.tsx rend un <div/> vide : aucune fonctionnalité livrée.",
  },
  {
    label: "Tests & outillage qualité",
    value: 8,
    tone: "alert",
    note: "Aucun test, aucun linter, aucune CI détectés.",
  },
];

export interface FileNode {
  name: string;
  kind: "folder" | "html" | "json" | "ts" | "css" | "js" | "lock";
  lines?: number;
  role: string;
  status: Tone;
  note?: string;
  depth: number;
}

export const TREE: FileNode[] = [
  { name: "sandbox-workspace/", kind: "folder", role: "Racine du projet", status: "neutral", depth: 0 },
  {
    name: "index.html",
    kind: "html",
    lines: 98,
    role: "Coquille HTML + scripts sandbox (thème, remontée d'erreurs)",
    status: "warn",
    note: "Appelle /src/main.jsx alors que le fichier est main.tsx · titre placeholder · lang=\"zh-CN\"",
    depth: 1,
  },
  {
    name: "package.json",
    kind: "json",
    lines: 37,
    role: "Manifeste — 13 deps prod, 9 dev, scripts dev / build / typecheck",
    status: "warn",
    note: "Aucun script test ni lint",
    depth: 1,
  },
  {
    name: "package-lock.json",
    kind: "lock",
    role: "Verrouillage des versions — présent, bon réflexe",
    status: "ok",
    depth: 1,
  },
  {
    name: "tsconfig.json",
    kind: "json",
    lines: 17,
    role: "Config TypeScript — strict activé, target ES2020",
    status: "ok",
    note: "noUnusedLocals / noUnusedParameters absents",
    depth: 1,
  },
  {
    name: "vite.config.js",
    kind: "js",
    lines: 16,
    role: "Plugins react + tailwindcss, serveur 0.0.0.0:3000",
    status: "info",
    note: "Fichier .js dans un projet TypeScript",
    depth: 1,
  },
  { name: "src/", kind: "folder", role: "Sources applicatives", status: "neutral", depth: 1 },
  {
    name: "main.tsx",
    kind: "ts",
    lines: 7,
    role: "Bootstrap React — montage de <App /> sur #root",
    status: "info",
    note: "Pas de <React.StrictMode>",
    depth: 2,
  },
  {
    name: "App.tsx",
    kind: "ts",
    lines: 6,
    role: "Composant racine — retourne un <div/> vide",
    status: "alert",
    note: "Application visuellement vide",
    depth: 2,
  },
  {
    name: "index.css",
    kind: "css",
    lines: 2,
    role: "Une seule directive : @import \"tailwindcss\"",
    status: "info",
    note: "Aucun jeton de design, aucune règle métier",
    depth: 2,
  },
];

export interface Dep {
  name: string;
  version: string;
  role: string;
  used: boolean;
  note?: string;
}

export const PROD_DEPS: Dep[] = [
  { name: "react", version: "^18.2.0", role: "Bibliothèque UI", used: true, note: "Seule dépendance réellement importée (via react-dom)" },
  { name: "react-dom", version: "^18.2.0", role: "Rendu DOM de React", used: true, note: "Importée dans main.tsx" },
  { name: "@supabase/supabase-js", version: "^2.98.0", role: "Client backend-as-a-service", used: false, note: "Aucun client initialisé, aucun .env détecté" },
  { name: "react-router-dom", version: "^6.8.0", role: "Routage SPA", used: false, note: "Aucun <Router> monté" },
  { name: "framer-motion", version: "^11.16.1", role: "Animations déclaratives", used: false },
  { name: "recharts", version: "^2.10.0", role: "Graphiques SVG", used: false },
  { name: "@dnd-kit/core", version: "^6.1.0", role: "Drag & drop — noyau", used: false },
  { name: "@dnd-kit/sortable", version: "^8.0.0", role: "Drag & drop — tri de listes", used: false },
  { name: "@dnd-kit/utilities", version: "^3.2.2", role: "Drag & drop — utilitaires", used: false },
  { name: "lucide-react", version: "^0.294.0", role: "Icônes SVG", used: false, note: "Version ancienne (gamme 0.2xx)" },
  { name: "date-fns", version: "^2.30.0", role: "Manipulation de dates", used: false, note: "v2 — la v4 est la gamme courante" },
  { name: "canvas-confetti", version: "^1.9.3", role: "Confettis canvas", used: false },
  { name: "uuid", version: "^9.0.1", role: "Génération d'identifiants", used: false },
];

export const DEV_DEPS: Dep[] = [
  { name: "vite", version: "^6.3.5", role: "Bundler & dev server", used: true },
  { name: "@vitejs/plugin-react", version: "^4.3.4", role: "Support React (Fast Refresh)", used: true },
  { name: "typescript", version: "^5.7.0", role: "Compilateur / typecheck", used: true },
  { name: "tailwindcss", version: "^4.1.7", role: "Framework CSS utilitaire v4", used: true },
  { name: "@tailwindcss/vite", version: "^4.1.7", role: "Plugin Tailwind officiel pour Vite", used: true },
  { name: "@types/react", version: "^18.2.0", role: "Typages React", used: true },
  { name: "@types/react-dom", version: "^18.2.0", role: "Typages ReactDOM", used: true },
  { name: "@types/uuid", version: "^9.0.7", role: "Typages uuid", used: false, note: "Pour une dépendance elle-même inutilisée" },
  { name: "@types/canvas-confetti", version: "^1.6.4", role: "Typages canvas-confetti", used: false, note: "Pour une dépendance elle-même inutilisée" },
];

export const STRENGTHS: { title: string; detail: string }[] = [
  {
    title: "Stack moderne et cohérente",
    detail: "Vite 6.3, React 18.2, TypeScript 5.7 et Tailwind CSS v4 via son plugin officiel : un outillage 2025+ homogène, sans bricolage webpack.",
  },
  {
    title: "TypeScript en mode strict",
    detail: "« strict: true » avec moduleResolution « bundler » et isolatedModules : la base la plus saine disponible, vérifiable via le script « typecheck ».",
  },
  {
    title: "Surface minimale, lisibilité maximale",
    detail: "16 lignes de config Vite, 183 lignes au total : n'importe quel développeur comprend le projet en cinq minutes.",
  },
  {
    title: "Versions verrouillées",
    detail: "package-lock.json présent : les installations sont reproductibles d'une machine à l'autre.",
  },
  {
    title: "Instrumentation sandbox soignée",
    detail: "index.html gère l'anti-flash de thème (clair/sombre) et fait remonter les erreurs JS runtime à la fenêtre parente, avec dédoublonnage.",
  },
];

export const ISSUES: { sev: "haute" | "moyenne" | "faible"; title: string; detail: string; file: string }[] = [
  {
    sev: "haute",
    title: "L'application ne rend rien",
    detail: "App.tsx retourne un <div/> vide : l'utilisateur final voit une page blanche. Aucune route, aucun composant, aucune donnée.",
    file: "src/App.tsx",
  },
  {
    sev: "haute",
    title: "13 dépendances… 0 import",
    detail: "dnd-kit, Supabase, Recharts, Router, Framer Motion, date-fns, uuid, confetti : tout est installé, rien n'est utilisé. Le manifeste promet des capacités que le code ne fournit pas.",
    file: "package.json",
  },
  {
    sev: "moyenne",
    title: "Entrée HTML incohérente",
    detail: "Le <script> charge « /src/main.jsx » alors que le fichier source s'appelle main.tsx. Vite résout l'extension, donc ça build — mais l'écart est un piège pour quiconque lit le projet.",
    file: "index.html",
  },
  {
    sev: "moyenne",
    title: "Font Awesome 6.4.0 en CDN, jamais utilisé",
    detail: "~80 Ko de CSS chargés depuis cdnjs à chaque démarrage, alors que lucide-react est déjà au manifeste et que rien n'utilise les classes « fa-* ».",
    file: "index.html",
  },
  {
    sev: "moyenne",
    title: "Métadonnées placeholder",
    detail: "Titre « coder-app-name » et lang=\"zh-CN\" : référencement, accessibilité et partage social (Open Graph) dégradés d'entrée de jeu.",
    file: "index.html",
  },
  {
    sev: "moyenne",
    title: "Zéro filet de sécurité",
    detail: "Aucun test unitaire, aucun linter (ESLint), aucun formateur configuré, aucune CI : rien ne protège contre les régressions.",
    file: "package.json",
  },
  {
    sev: "faible",
    title: "StrictMode absent",
    detail: "main.tsx monte <App /> sans <React.StrictMode> : détection des effets de bord impurs désactivée en développement.",
    file: "src/main.tsx",
  },
  {
    sev: "faible",
    title: "Config Vite en JavaScript",
    detail: "vite.config.js est en .js dans un projet 100 % TypeScript ; le tsconfig ne déclare pas non plus les types « vite/client ».",
    file: "vite.config.js",
  },
];

export interface Reco {
  priority: "P1" | "P2" | "P3";
  title: string;
  why: string;
  action: string;
}

export const RECOS: Reco[] = [
  {
    priority: "P1",
    title: "Donner un contenu à l'application",
    why: "Le projet est techniquement prêt mais fonctionnellement vide : c'est le seul point qui bloque toute valeur utilisateur.",
    action: "Remplacer le <div/> de App.tsx par la vraie interface ; introduire le routage (react-router-dom est déjà là) si plusieurs vues sont prévues.",
  },
  {
    priority: "P1",
    title: "Aligner l'entrée HTML sur la réalité",
    why: "« /src/main.jsx » ≠ main.tsx, titre placeholder, lang incohérent : trois corrections triviales à fort impact (SEO, a11y, crédibilité).",
    action: "Pointer le script vers /src/main.tsx, définir un vrai <title>, passer lang=\"fr\" et retirer le CDN Font Awesome.",
  },
  {
    priority: "P2",
    title: "Trancher le sort des dépendances dormantes",
    why: "Chaque dépendance inutilisée est une surface d'attaque potentielle, un install alourdi et une promesse trompeuse dans le manifeste.",
    action: "Soit les câbler dans l'application (Supabase, graphiques, dnd…), soit les retirer proprement avec leurs @types.",
  },
  {
    priority: "P2",
    title: "Installer un socle qualité minimal",
    why: "Aucun garde-fou : la première fonctionnalité d'envergure sera livrée sans filet.",
    action: "Ajouter ESLint (+ config React), un runner de tests (Vitest s'intègre nativement à Vite), activer noUnusedLocals et monter <React.StrictMode>.",
  },
  {
    priority: "P3",
    title: "Homogénéiser et rafraîchir",
    why: "Détails de cohérence et de fraîcheur qui pèseront dans la maintenance longue.",
    action: "Passer vite.config en .ts, actualiser date-fns (v4) et lucide-react, définir des jetons de design dans index.css (@theme Tailwind v4).",
  },
];

export const TERMINAL_LINES: { text: string; tone: Tone }[] = [
  { text: "$ audit --cible sandbox-workspace --mode lecture-seule", tone: "neutral" },
  { text: "→ 8 fichiers ouverts, 183 lignes lues, 0 octet modifié", tone: "info" },
  { text: "✔ stack      Vite 6.3.5 · React 18.2 · TS 5.7 strict · Tailwind 4.1.7", tone: "ok" },
  { text: "✔ build      vite build exécutable sans erreur détectée", tone: "ok" },
  { text: "✔ lockfile   package-lock.json présent et cohérent", tone: "ok" },
  { text: "! src        App.tsx retourne <div/> — rendu utilisateur vide", tone: "warn" },
  { text: "! deps       13 dépendances de production, 0 import dans src/", tone: "warn" },
  { text: "! html       /src/main.jsx référencé, fichier réel main.tsx", tone: "warn" },
  { text: "! html       Font Awesome 6.4.0 en CDN — aucun usage trouvé", tone: "warn" },
  { text: "✘ qualité    0 test · 0 linter · 0 CI · StrictMode absent", tone: "alert" },
  { text: "→ verdict    62/100 — fondations saines, application à construire", tone: "info" },
  { text: "→ aucune modification appliquée (contrat lecture seule respecté)", tone: "ok" },
];

export const TICKER = [
  "index.html",
  "package.json",
  "tsconfig.json",
  "vite.config.js",
  "src/main.tsx",
  "src/App.tsx",
  "src/index.css",
  "package-lock.json",
];
