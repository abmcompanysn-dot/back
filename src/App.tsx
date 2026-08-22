import { useEffect, useState } from "react";
import {
  COUNTERS,
  DEV_DEPS,
  ISSUES,
  NAV,
  PROD_DEPS,
  PROJECT,
  RECOS,
  STRENGTHS,
  SUBSCORES,
  TERMINAL_LINES,
  TICKER,
  TREE,
  type Tone,
} from "./report/data";
import {
  Badge,
  Counter,
  Gauge,
  Ic,
  Reveal,
  ScoreBar,
  SectionHead,
  Terminal,
} from "./report/ui";

/* ================= scroll-spy + progress ================= */
function useScrollSpy(ids: readonly string[]) {
  const [active, setActive] = useState(ids[0] ?? "");
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const sections = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setActive(e.target.id);
        }
      },
      { rootMargin: "-38% 0px -55% 0px" }
    );
    sections.forEach((s) => io.observe(s));
    return () => io.disconnect();
  }, [ids]);

  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const h = document.documentElement;
        const max = h.scrollHeight - h.clientHeight;
        setProgress(max > 0 ? (h.scrollTop / max) * 100 : 0);
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);

  return { active, progress };
}

const NAV_IDS = NAV.map((n) => n.id);

const TONE_DOT: Record<Tone, string> = {
  ok: "bg-moss",
  warn: "bg-amber",
  alert: "bg-coral",
  info: "bg-sky",
  neutral: "bg-dim",
};

const FILE_ICON: Record<string, (p: { className?: string }) => React.ReactNode> = {
  folder: Ic.folder,
  html: Ic.code,
  json: Ic.doc,
  ts: Ic.code,
  js: Ic.code,
  css: Ic.code,
  lock: Ic.lock,
};

/* ================= app ================= */
export default function App() {
  const { active, progress } = useScrollSpy(NAV_IDS);

  return (
    <div className="relative min-h-screen bg-ink font-body text-paper">
      {/* ambient layers */}
      <div className="bg-dotgrid pointer-events-none fixed inset-0 z-0 opacity-60" />
      <div className="pointer-events-none fixed -top-40 right-[-10%] z-0 h-[520px] w-[520px] rounded-full bg-teal/10 blur-[130px] glow-drift" />
      <div className="pointer-events-none fixed bottom-[-15%] left-[-8%] z-0 h-[480px] w-[480px] rounded-full bg-amber/10 blur-[130px] glow-drift-slow" />
      <div className="noise-overlay" />

      {/* progress */}
      <div className="fixed inset-x-0 top-0 z-50 h-[3px] bg-line/40">
        <div
          className="h-full bg-gradient-to-r from-teal via-sky to-amber transition-[width] duration-150 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* ---------- sidebar (desktop) ---------- */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[272px] flex-col border-r border-line bg-ink2/85 backdrop-blur-sm lg:flex">
        <div className="border-b border-line px-6 py-6">
          <div className="flex items-center gap-2.5">
            <span className="clip-corner flex h-9 w-9 items-center justify-center bg-amber text-ink">
              <Ic.eye className="h-4.5 w-4.5" />
            </span>
            <div>
              <p className="font-display text-[15px] font-bold leading-tight tracking-tight">
                Audit Dossier
              </p>
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-dim">
                {PROJECT.ref}
              </p>
            </div>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-4 py-6">
          <p className="px-2 pb-3 font-mono text-[10px] uppercase tracking-[0.24em] text-dim">
            Sections du rapport
          </p>
          <ul className="space-y-1">
            {NAV.map((n) => {
              const isActive = active === n.id;
              return (
                <li key={n.id}>
                  <a
                    href={`#${n.id}`}
                    className={`group flex items-center gap-3 border-l-2 px-3 py-2.5 transition-all duration-200 ${
                      isActive
                        ? "border-amber bg-panel text-paper"
                        : "border-transparent text-mist hover:border-line2 hover:bg-panel/60 hover:text-paper"
                    }`}
                  >
                    <span
                      className={`font-mono text-[10.5px] tabular-nums transition-colors ${
                        isActive ? "text-amber" : "text-dim group-hover:text-mist"
                      }`}
                    >
                      {n.num}
                    </span>
                    <span className="font-display text-[13.5px] font-medium tracking-wide">
                      {n.label}
                    </span>
                    {isActive && (
                      <span className="ml-auto h-1.5 w-1.5 rounded-full bg-amber" />
                    )}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="border-t border-line px-6 py-5">
          <div className="flex items-center gap-2.5 text-amber">
            <Ic.lock className="h-4 w-4" />
            <p className="font-mono text-[10.5px] uppercase tracking-[0.18em]">
              Mode lecture seule
            </p>
          </div>
          <p className="mt-2 text-[12px] leading-snug text-dim">
            Aucune ligne du projet n'a été modifiée pendant cette analyse.
          </p>
        </div>
      </aside>

      {/* ---------- topbar (mobile) ---------- */}
      <div className="sticky top-0 z-40 border-b border-line bg-ink2/90 backdrop-blur-sm lg:hidden">
        <div className="flex items-center gap-2.5 px-4 pt-3">
          <span className="clip-corner flex h-7 w-7 items-center justify-center bg-amber text-ink">
            <Ic.eye className="h-3.5 w-3.5" />
          </span>
          <p className="font-display text-sm font-bold">Audit Dossier</p>
          <span className="ml-auto flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-amber">
            <Ic.lock className="h-3 w-3" /> lecture seule
          </span>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 py-2.5 [scrollbar-width:none]">
          {NAV.map((n) => (
            <a
              key={n.id}
              href={`#${n.id}`}
              className={`whitespace-nowrap border px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider transition-colors ${
                active === n.id
                  ? "border-amber/60 bg-amber/10 text-amber"
                  : "border-line text-mist hover:text-paper"
              }`}
            >
              {n.num} · {n.label}
            </a>
          ))}
        </nav>
      </div>

      {/* ---------- main ---------- */}
      <main className="relative z-10 lg:pl-[272px]">
        <div className="mx-auto max-w-5xl px-5 sm:px-10 lg:px-14">
          {/* ============ COVER ============ */}
          <header className="scanline relative overflow-hidden border-b border-line pt-14 pb-0 sm:pt-20">
            <Reveal>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-[11px] uppercase tracking-[0.22em] text-dim">
                <span>Rapport nº <span className="text-amber">{PROJECT.ref}</span></span>
                <span className="hidden h-3 w-px bg-line2 sm:block" />
                <span>{PROJECT.date}</span>
                <span className="hidden h-3 w-px bg-line2 sm:block" />
                <span className="text-teal">analyse statique complète</span>
              </div>
            </Reveal>

            <div className="mt-8 grid gap-12 lg:grid-cols-[1.45fr_1fr] lg:gap-8">
              <div>
                <Reveal delay={80}>
                  <h1 className="font-display text-[clamp(2.6rem,6vw,4.4rem)] font-bold leading-[0.98] tracking-tight text-paper">
                    Compte rendu
                    <br />
                    d'audit <span className="text-amber">intégral</span>
                  </h1>
                </Reveal>
                <Reveal delay={180}>
                  <p className="mt-6 max-w-xl text-[15.5px] leading-relaxed text-mist">
                    Analyse complète du projet{" "}
                    <span className="font-mono text-[13.5px] text-sky">
                      {PROJECT.name}
                    </span>{" "}
                    — structure, stack, dépendances, code et outillage — réalisée
                    selon un contrat strict :{" "}
                    <strong className="font-semibold text-paper">
                      observer, mesurer, ne rien toucher.
                    </strong>
                  </p>
                </Reveal>
                <Reveal delay={280}>
                  <div className="mt-8 flex flex-wrap items-center gap-3">
                    <Badge tone="warn">
                      <Ic.lock className="h-3 w-3" /> {PROJECT.mode}
                    </Badge>
                    <Badge tone="info">
                      <Ic.file className="h-3 w-3" /> {PROJECT.filesAnalyzed} fichiers
                    </Badge>
                    <Badge tone="alert">
                      <Ic.warn className="h-3 w-3" /> {ISSUES.length} constats
                    </Badge>
                    <Badge tone="ok">
                      <Ic.check className="h-3 w-3" /> {RECOS.length} recommandations
                    </Badge>
                  </div>
                </Reveal>

                <Reveal delay={360}>
                  <div className="relative mt-10 inline-block">
                    <div className="stamp rotate-[-7deg] px-6 py-3 text-center">
                      <p className="font-display text-lg font-bold uppercase tracking-[0.3em] text-amber">
                        Lecture seule
                      </p>
                      <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.2em] text-amber/70">
                        0 octet modifié · contrat respecté
                      </p>
                    </div>
                  </div>
                </Reveal>
              </div>

              <Reveal delay={240} className="flex items-start justify-center lg:justify-end lg:pt-2">
                <div className="clip-corner border border-line bg-panel/70 p-8 backdrop-blur-sm">
                  <Gauge
                    value={PROJECT.score}
                    label="Score global"
                    caption={PROJECT.verdict}
                  />
                </div>
              </Reveal>
            </div>

            {/* ticker */}
            <div className="relative mt-12 overflow-hidden border-t border-line py-3">
              <div className="ticker-track flex w-max items-center gap-8 whitespace-nowrap font-mono text-[11px] uppercase tracking-[0.22em] text-dim">
                {[...TICKER, ...TICKER].map((t, i) => (
                  <span key={i} className="flex items-center gap-8">
                    <span className="transition-colors hover:text-amber">{t}</span>
                    <span className="text-line2">·</span>
                  </span>
                ))}
              </div>
            </div>
          </header>

          {/* ============ 01 SYNTHÈSE ============ */}
          <section id="synthese" className="scroll-mt-28 py-16 sm:py-20">
            <SectionHead
              num="01"
              kicker="Vue d'ensemble"
              title="Synthèse exécutive"
              intro="Le projet est un espace de travail React + Vite + TypeScript flambant neuf… dont l'application reste à écrire. Tout l'outillage répond présent ; le code métier, lui, n'existe pas encore."
            />

            <div className="grid grid-cols-2 gap-px overflow-hidden border border-line bg-line sm:grid-cols-3">
              {COUNTERS.map((c, i) => (
                <Reveal key={c.label} delay={i * 70} className="bg-panel">
                  <div className="group h-full px-5 py-6 transition-colors duration-300 hover:bg-panel2 sm:px-7 sm:py-8">
                    <p className="font-display text-4xl font-bold tabular-nums tracking-tight sm:text-5xl">
                      <Counter
                        to={c.value}
                        suffix={c.suffix}
                        className={
                          c.tone === "ok"
                            ? "text-moss"
                            : c.tone === "warn"
                            ? "text-amber"
                            : "text-paper"
                        }
                      />
                    </p>
                    <p className="mt-2 text-[13px] leading-snug text-mist">{c.label}</p>
                    <span
                      className={`mt-4 block h-[3px] w-8 transition-all duration-300 group-hover:w-14 ${TONE_DOT[c.tone as Tone]}`}
                    />
                  </div>
                </Reveal>
              ))}
            </div>

            <Reveal delay={120} className="mt-10">
              <div className="border border-line bg-panel/60 p-6 sm:p-8">
                <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-dim">
                  Notation par domaine
                </p>
                <div className="mt-6 grid gap-x-10 gap-y-7 lg:grid-cols-2">
                  {SUBSCORES.map((s, i) => (
                    <ScoreBar key={s.label} {...s} delay={i * 140} />
                  ))}
                </div>
              </div>
            </Reveal>
          </section>

          {/* ============ 02 STACK ============ */}
          <section id="stack" className="scroll-mt-28 border-t border-line py-16 sm:py-20">
            <SectionHead
              num="02"
              kicker="Infrastructure"
              title="Stack technique"
              intro="Un socle 2025+ cohérent : bundler rapide, typage strict, CSS utilitaire de dernière génération. Aucune pièce exotique, aucune dette d'outillage."
            />

            <div className="grid gap-4 sm:grid-cols-2">
              {[
                {
                  icon: Ic.chip,
                  name: "Vite 6.3.5",
                  desc: "Bundler et serveur de développement — config minimale de 16 lignes, plugins React et Tailwind, serveur fixé sur 0.0.0.0:3000.",
                  tag: "build",
                  tone: "ok" as Tone,
                },
                {
                  icon: Ic.code,
                  name: "React 18.2",
                  desc: "Bibliothèque d'interface, montée via createRoot dans main.tsx. Montage fonctionnel mais sans StrictMode.",
                  tag: "ui",
                  tone: "info" as Tone,
                },
                {
                  icon: Ic.doc,
                  name: "TypeScript 5.7",
                  desc: "Mode strict activé, target ES2020, résolution « bundler ». Vérifiable par le script « npm run typecheck ».",
                  tag: "typage",
                  tone: "ok" as Tone,
                },
                {
                  icon: Ic.box,
                  name: "Tailwind CSS 4.1.7",
                  desc: "Intégré via le plugin Vite officiel — une seule ligne de CSS suffit (@import \"tailwindcss\"). Aucun thème personnalisé défini.",
                  tag: "style",
                  tone: "info" as Tone,
                },
              ].map((s, i) => (
                <Reveal key={s.name} delay={i * 90}>
                  <div className="group h-full border border-line bg-panel p-6 transition-all duration-300 hover:-translate-y-1 hover:border-line2 hover:bg-panel2">
                    <div className="flex items-center justify-between">
                      <span className="flex h-10 w-10 items-center justify-center border border-line2 text-teal transition-colors group-hover:border-teal/50 group-hover:text-paper">
                        <s.icon className="h-5 w-5" />
                      </span>
                      <Badge tone={s.tone}>{s.tag}</Badge>
                    </div>
                    <h3 className="mt-4 font-display text-lg font-bold text-paper">
                      {s.name}
                    </h3>
                    <p className="mt-2 text-[13.5px] leading-relaxed text-mist">{s.desc}</p>
                  </div>
                </Reveal>
              ))}
            </div>

            <Reveal delay={160} className="mt-6">
              <div className="flex flex-wrap items-center gap-x-8 gap-y-2 border border-dashed border-line2 px-6 py-4 font-mono text-[12px] text-mist">
                <span className="uppercase tracking-[0.2em] text-dim">Scripts npm</span>
                <span><span className="text-teal">dev</span> — serveur local</span>
                <span><span className="text-teal">build</span> — bundle de production</span>
                <span><span className="text-teal">typecheck</span> — contrôle TS</span>
                <span className="text-coral">test — absent</span>
                <span className="text-coral">lint — absent</span>
              </div>
            </Reveal>
          </section>

          {/* ============ 03 FICHIERS ============ */}
          <section id="fichiers" className="scroll-mt-28 border-t border-line py-16 sm:py-20">
            <SectionHead
              num="03"
              kicker="Anatomie"
              title="Fichiers & arborescence"
              intro="Huit fichiers, cent quatre-vingt-trois lignes : le projet tient sur une page. Chaque entrée ci-dessous a été ouverte, lue et annotée manuellement."
            />

            <Reveal>
              <div className="overflow-hidden border border-line bg-panel/60">
                {TREE.map((f, i) => {
                  const IconCmp = FILE_ICON[f.kind] ?? Ic.file;
                  return (
                    <div
                      key={f.name + i}
                      className={`row-slide group flex flex-col gap-1 border-b border-line/60 px-4 py-3.5 last:border-b-0 hover:bg-panel2 sm:flex-row sm:items-center sm:gap-4 sm:px-6 ${
                        f.kind === "folder" ? "bg-ink2/60" : ""
                      }`}
                      style={{ paddingLeft: `${(f.kind === "folder" ? 16 : 24) + f.depth * 26}px` }}
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-3">
                        <span
                          className={`shrink-0 ${
                            f.kind === "folder"
                              ? "text-amber"
                              : f.status === "alert"
                              ? "text-coral"
                              : f.status === "warn"
                              ? "text-amber"
                              : "text-sky"
                          }`}
                        >
                          <IconCmp className="h-4.5 w-4.5" />
                        </span>
                        <div className="min-w-0">
                          <p
                            className={`truncate font-mono text-[13.5px] ${
                              f.kind === "folder"
                                ? "font-semibold text-paper"
                                : "text-paper/90"
                            }`}
                          >
                            {f.name}
                          </p>
                          <p className="truncate text-[12.5px] text-mist">{f.role}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 pl-8 sm:pl-0">
                        {f.lines !== undefined && (
                          <span className="font-mono text-[11px] tabular-nums text-dim">
                            {f.lines} L
                          </span>
                        )}
                        {f.note && (
                          <span
                            className={`hidden max-w-[260px] truncate font-mono text-[11px] lg:block ${
                              f.status === "alert" ? "text-coral/85" : "text-amber/85"
                            }`}
                            title={f.note}
                          >
                            › {f.note}
                          </span>
                        )}
                        <span
                          className={`h-2 w-2 shrink-0 rounded-full ${TONE_DOT[f.status]}`}
                          title={f.status}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </Reveal>

            <Reveal delay={120} className="mt-5">
              <p className="flex items-start gap-2.5 text-[13px] leading-relaxed text-dim">
                <Ic.warn className="mt-0.5 h-4 w-4 shrink-0 text-amber" />
                Lecture : le point coloré indique l'état du fichier —{" "}
                <span className="text-moss">sain</span>,{" "}
                <span className="text-sky">informationnel</span>,{" "}
                <span className="text-amber">à surveiller</span>,{" "}
                <span className="text-coral">bloquant</span>.
              </p>
            </Reveal>
          </section>

          {/* ============ 04 DÉPENDANCES ============ */}
          <section id="dependances" className="scroll-mt-28 border-t border-line py-16 sm:py-20">
            <SectionHead
              num="04"
              kicker="Manifeste"
              title="Dépendances : le grand écart"
              intro={`Sur ${PROJECT.prodDeps} dépendances de production déclarées, une seule est réellement importée par le code. Le manifeste décrit une application riche (drag & drop, graphiques, backend Supabase, routage…) que le code ne contient pas.`}
            />

            <Reveal>
              <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.24em] text-dim">
                Production — 13 paquets
              </p>
              <div className="overflow-hidden border border-line bg-panel/60">
                {PROD_DEPS.map((d) => (
                  <div
                    key={d.name}
                    className="row-slide group grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 border-b border-line/60 px-4 py-3 last:border-b-0 hover:bg-panel2 sm:grid-cols-[220px_1fr_110px_150px] sm:px-6"
                  >
                    <p className="font-mono text-[13px] text-paper">{d.name}</p>
                    <p className="col-span-2 text-[12.5px] text-mist sm:col-span-1">
                      {d.role}
                      {d.note && (
                        <span className="block text-[11.5px] text-dim sm:hidden">
                          {d.note}
                        </span>
                      )}
                    </p>
                    <p className="hidden font-mono text-[12px] text-sky sm:block">{d.version}</p>
                    <div className="col-start-2 sm:col-start-4 sm:justify-self-end">
                      {d.used ? (
                        <Badge tone="ok">
                          <Ic.check className="h-3 w-3" /> importée
                        </Badge>
                      ) : (
                        <Badge tone="warn">
                          <Ic.warn className="h-3 w-3" /> 0 import
                        </Badge>
                      )}
                    </div>
                    {d.note && (
                      <p className="hidden text-[11.5px] text-dim sm:col-span-4 sm:block sm:pl-1">
                        ↳ {d.note}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </Reveal>

            <Reveal delay={140} className="mt-10">
              <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.24em] text-dim">
                Développement — 9 paquets
              </p>
              <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                {DEV_DEPS.map((d) => (
                  <div
                    key={d.name}
                    className="group border border-line bg-panel px-4 py-3.5 transition-colors hover:border-line2 hover:bg-panel2"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="truncate font-mono text-[12.5px] text-paper">{d.name}</p>
                      <p className="shrink-0 font-mono text-[11px] text-teal">{d.version}</p>
                    </div>
                    <p className="mt-1 text-[12px] text-mist">{d.role}</p>
                  </div>
                ))}
              </div>
            </Reveal>

            <Reveal delay={200} className="mt-8">
              <div className="clip-corner-bl border border-amber/35 bg-amber/[0.06] px-6 py-5">
                <p className="flex items-start gap-3 text-[14px] leading-relaxed text-paper/90">
                  <Ic.flag className="mt-0.5 h-4.5 w-4.5 shrink-0 text-amber" />
                  <span>
                    <strong className="font-semibold text-amber">Signal faible à noter :</strong>{" "}
                    des typages (<span className="font-mono text-[12.5px]">@types/uuid</span>,{" "}
                    <span className="font-mono text-[12.5px]">@types/canvas-confetti</span>) ont
                    été installés pour des bibliothèques jamais importées — la preuve que ces
                    dépendances étaient prévues, puis abandonnées en cours de route.
                  </span>
                </p>
              </div>
            </Reveal>
          </section>

          {/* ============ 05 CONSTATS ============ */}
          <section id="constats" className="scroll-mt-28 border-t border-line py-16 sm:py-20">
            <SectionHead
              num="05"
              kicker="Diagnostic"
              title="Constats détaillés"
              intro="Cinq motifs de satisfaction, huit points de vigilance classés par sévérité. Chaque constat renvoie au fichier source exact — vérifiable en trente secondes."
            />

            <div className="grid gap-10 lg:grid-cols-[1fr_1.25fr]">
              {/* strengths */}
              <Reveal>
                <div className="flex items-center gap-3">
                  <span className="flex h-8 w-8 items-center justify-center border border-moss/40 bg-moss/10 text-moss">
                    <Ic.check className="h-4 w-4" />
                  </span>
                  <h3 className="font-display text-lg font-bold text-paper">
                    Points forts <span className="text-moss">×{STRENGTHS.length}</span>
                  </h3>
                </div>
                <ul className="mt-5 space-y-3">
                  {STRENGTHS.map((s, i) => (
                    <li
                      key={s.title}
                      className="group border border-line border-l-2 border-l-moss/70 bg-panel px-5 py-4 transition-all duration-300 hover:translate-x-1 hover:bg-panel2"
                    >
                      <p className="font-display text-[14.5px] font-semibold text-paper">
                        <span className="mr-2 font-mono text-[11px] text-moss tabular-nums">
                          {String(i + 1).padStart(2, "0")}
                        </span>
                        {s.title}
                      </p>
                      <p className="mt-1.5 text-[13px] leading-relaxed text-mist">{s.detail}</p>
                    </li>
                  ))}
                </ul>
              </Reveal>

              {/* issues */}
              <Reveal delay={120}>
                <div className="flex items-center gap-3">
                  <span className="flex h-8 w-8 items-center justify-center border border-coral/40 bg-coral/10 text-coral">
                    <Ic.warn className="h-4 w-4" />
                  </span>
                  <h3 className="font-display text-lg font-bold text-paper">
                    Vigilances <span className="text-coral">×{ISSUES.length}</span>
                  </h3>
                </div>
                <ul className="mt-5 space-y-3">
                  {ISSUES.map((iss, i) => (
                    <li
                      key={iss.title}
                      className="group border border-line bg-panel px-5 py-4 transition-all duration-300 hover:translate-x-1 hover:border-line2 hover:bg-panel2"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          tone={
                            iss.sev === "haute"
                              ? "alert"
                              : iss.sev === "moyenne"
                              ? "warn"
                              : "info"
                          }
                        >
                          {iss.sev}
                        </Badge>
                        <p className="font-display text-[14.5px] font-semibold text-paper">
                          {iss.title}
                        </p>
                        <span className="ml-auto font-mono text-[11px] text-dim transition-colors group-hover:text-sky">
                          {iss.file}
                        </span>
                      </div>
                      <p className="mt-2 text-[13px] leading-relaxed text-mist">{iss.detail}</p>
                    </li>
                  ))}
                </ul>
              </Reveal>
            </div>
          </section>

          {/* ============ 06 TERMINAL ============ */}
          <section id="terminal" className="scroll-mt-28 border-t border-line py-16 sm:py-20">
            <SectionHead
              num="06"
              kicker="Trace brute"
              title="Journal d'analyse"
              intro="La séance d'audit condensée en douze lignes, rejouée ci-dessous caractère par caractère."
            />
            <Reveal>
              <Terminal lines={TERMINAL_LINES} />
            </Reveal>
          </section>

          {/* ============ 07 RECOMMANDATIONS ============ */}
          <section id="recommandations" className="scroll-mt-28 border-t border-line py-16 sm:py-20">
            <SectionHead
              num="07"
              kicker="Plan d'action"
              title="Recommandations priorisées"
              intro="Cinq chantiers classés par priorité. Conformément au mandat, aucune de ces actions n'a été appliquée : elles sont proposées, pas exécutées."
            />

            <Reveal className="mb-8">
              <div className="flex items-center gap-3 border border-line bg-ink2/70 px-5 py-4">
                <Ic.lock className="h-5 w-5 shrink-0 text-amber" />
                <p className="font-mono text-[12px] uppercase tracking-[0.16em] text-mist">
                  Modifications appliquées à ce jour : <span className="text-paper">0</span>
                </p>
                <span className="ml-auto hidden sm:block">
                  <Badge tone="warn">mandat : lecture seule</Badge>
                </span>
              </div>
            </Reveal>

            <ol className="space-y-4">
              {RECOS.map((r, i) => (
                <Reveal key={r.title} delay={i * 90}>
                  <li className="group grid gap-5 border border-line bg-panel p-6 transition-all duration-300 hover:border-line2 hover:bg-panel2 sm:grid-cols-[64px_1fr] sm:p-7">
                    <div className="flex sm:flex-col sm:items-center sm:gap-2">
                      <span
                        className={`clip-corner flex h-11 w-11 items-center justify-center font-display text-[15px] font-bold ${
                          r.priority === "P1"
                            ? "bg-amber text-ink"
                            : r.priority === "P2"
                            ? "bg-sky/20 text-sky ring-1 ring-sky/40"
                            : "bg-panel2 text-mist ring-1 ring-line2"
                        }`}
                      >
                        {r.priority}
                      </span>
                    </div>
                    <div>
                      <h3 className="font-display text-[17px] font-bold text-paper transition-colors group-hover:text-amber">
                        {r.title}
                      </h3>
                      <div className="mt-3 grid gap-4 sm:grid-cols-2">
                        <div>
                          <p className="font-mono text-[10.5px] uppercase tracking-[0.22em] text-dim">
                            Pourquoi
                          </p>
                          <p className="mt-1.5 text-[13.5px] leading-relaxed text-mist">{r.why}</p>
                        </div>
                        <div>
                          <p className="font-mono text-[10.5px] uppercase tracking-[0.22em] text-dim">
                            Action proposée
                          </p>
                          <p className="mt-1.5 flex items-start gap-2 text-[13.5px] leading-relaxed text-paper/85">
                            <Ic.arrow className="mt-1 h-3.5 w-3.5 shrink-0 text-teal" />
                            {r.action}
                          </p>
                        </div>
                      </div>
                    </div>
                  </li>
                </Reveal>
              ))}
            </ol>
          </section>

          {/* ============ 08 VERDICT ============ */}
          <section id="verdict" className="scroll-mt-28 border-t border-line py-16 sm:py-24">
            <SectionHead num="08" kicker="Conclusion" title="Verdict & méthode" />

            <div className="grid gap-10 lg:grid-cols-[1.2fr_1fr]">
              <Reveal>
                <blockquote className="border-l-2 border-amber pl-6">
                  <p className="font-display text-2xl font-bold leading-snug tracking-tight text-paper sm:text-[28px]">
                    « Un chantier proprement préparé, dont il reste à construire
                    la maison. »
                  </p>
                </blockquote>
                <p className="mt-6 max-w-xl text-[14.5px] leading-relaxed text-mist">
                  Note globale <strong className="font-semibold text-paper">{PROJECT.score}/100</strong> —{" "}
                  {PROJECT.verdict.toLowerCase()}. L'infrastructure, le typage et la
                  reproductibilité sont au niveau ; l'absence totale de code applicatif,
                  de tests et d'outillage qualité explique la retenue de la note. Rien
                  n'est cassé : tout est en attente.
                </p>

                <div className="mt-8">
                  <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-dim">
                    Méthodologie
                  </p>
                  <ul className="mt-4 space-y-3">
                    {[
                      "Lecture intégrale des 8 fichiers du dépôt, ligne à ligne (183 lignes).",
                      "Contrôle de cohérence entre index.html, main.tsx, vite.config.js et tsconfig.json.",
                      "Inventaire du manifeste : 22 paquets croisés contre les imports réels de src/.",
                      "Recherche d'usages (classes fa-*, appels Supabase, Router, tests, CI) — aucun trouvé.",
                      "Scoring par domaine pondéré ; aucune écriture sur le dépôt pendant la mission.",
                    ].map((m, i) => (
                      <li key={i} className="flex items-start gap-3 text-[13.5px] leading-relaxed text-mist">
                        <span className="mt-0.5 font-mono text-[11px] font-semibold text-teal tabular-nums">
                          {String(i + 1).padStart(2, "0")}
                        </span>
                        {m}
                      </li>
                    ))}
                  </ul>
                </div>
              </Reveal>

              <Reveal delay={150}>
                <div className="clip-corner border border-line bg-panel p-7">
                  <div className="flex items-center justify-between border-b border-line pb-4">
                    <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-dim">
                      Feuille de séance
                    </p>
                    <Ic.scale className="h-4.5 w-4.5 text-amber" />
                  </div>
                  <dl className="mt-5 space-y-4">
                    {[
                      ["Projet audité", PROJECT.name],
                      ["Référence", PROJECT.ref],
                      ["Période", PROJECT.date],
                      ["Périmètre", "dépôt complet, statique"],
                      ["Fichiers ouverts", `${PROJECT.filesAnalyzed} / ${PROJECT.filesAnalyzed}`],
                      ["Lignes analysées", `${PROJECT.totalLines}`],
                      ["Modifications", "0 (lecture seule)"],
                      ["Verdict", `${PROJECT.score}/100`],
                    ].map(([k, v]) => (
                      <div key={k} className="flex items-baseline justify-between gap-4">
                        <dt className="text-[13px] text-mist">{k}</dt>
                        <dd className="border-b border-dotted border-line2 pb-0.5 font-mono text-[12.5px] text-paper">
                          {v}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <div className="mt-7 border-t border-line pt-5">
                    <p className="font-display text-lg font-bold text-paper">L'Auditeur</p>
                    <p className="mt-1 text-[12.5px] leading-relaxed text-dim">
                      Analyse automatisée assistée — chaque chiffre de ce rapport
                      provient d'une lecture directe des fichiers du projet.
                    </p>
                  </div>
                </div>
              </Reveal>
            </div>
          </section>

          {/* footer */}
          <footer className="border-t border-line py-10">
            <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
              <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-dim">
                {PROJECT.ref} · {PROJECT.name} · {PROJECT.date}
              </p>
              <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-mist">
                <Ic.lock className="h-3.5 w-3.5 text-amber" />
                rapport généré sans toucher au code source
              </p>
            </div>
          </footer>
        </div>
      </main>
    </div>
  );
}
