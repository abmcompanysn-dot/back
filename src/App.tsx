import { useEffect, useRef, useState } from "react";
import {
  SERVICES,
  NODE_W,
  NODE_H,
  INCIDENTS,
  GOALS,
  CONSTRAINTS,
  STACK,
  LEDGER,
  TABLES,
  ENDPOINTS,
  FEATURES,
  PHASES,
  OUT_OF_SCOPE,
  DEPLOY_STEPS,
  COMPOSE_STACK,
  PROMPT,
  STATS,
  NOW_STEPS,
  K8S_COMPARE,
  K8S_PATH,
  VPS_ACCESS,
  TRANSFER,
  ADMIN_VIEWS,
  AUTH_FLOWS,
  type Service,
} from "./data";
import {
  Reveal,
  Counter,
  CopyButton,
  SectionHead,
  StatusDot,
  MethodChip,
  CmdBlock,
  Glyph,
} from "./ui";

/* ============================================================
   Navigation
   ============================================================ */

const SECTIONS = [
  { id: "board", n: "00", label: "Console" },
  { id: "incidents", n: "01", label: "Pourquoi partir" },
  { id: "objectifs", n: "02", label: "Objectifs" },
  { id: "stack", n: "03", label: "Stack" },
  { id: "data", n: "04", label: "Données" },
  { id: "api", n: "05", label: "API" },
  { id: "features", n: "06", label: "Fonctionnalités" },
  { id: "migration", n: "07", label: "Migration" },
  { id: "prompt", n: "09", label: "Prompt" },
  { id: "vps", n: "10", label: "VPS" },
  { id: "git", n: "11", label: "Git & CI" },
  { id: "maintenant", n: "12", label: "Maintenant" },
  { id: "admin", n: "13", label: "Admin" },
];

function useScrollSpy() {
  const [active, setActive] = useState("board");
  useEffect(() => {
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-30% 0px -55% 0px" }
    );
    SECTIONS.forEach((s) => {
      const el = document.getElementById(s.id);
      if (el) obs.observe(el);
    });
    return () => obs.disconnect();
  }, []);
  return active;
}

function TopBar() {
  const active = useScrollSpy();
  return (
    <header className="sticky top-0 z-50 border-b border-line bg-bg/85 backdrop-blur-md">
      <div className="max-w-[1200px] mx-auto px-5 h-[54px] flex items-center gap-5">
        <a href="#board" className="flex items-center gap-3 shrink-0">
          <span className="w-7 h-7 rounded-md bg-ok/15 border border-ok/40 grid place-items-center">
            <svg viewBox="0 0 16 16" className="w-4 h-4 text-ok" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <path d="M2 11.5 5.5 8 8 10l4-5M12 5h2v2" />
            </svg>
          </span>
          <span className="font-display font-extrabold tracking-tight text-[15px] leading-none">
            MIAD MARKET
            <span className="block font-mono font-normal text-[9px] tracking-[0.22em] text-mut mt-1">
              BACKEND SANS WORDPRESS
            </span>
          </span>
        </a>
        <nav className="hidden lg:flex items-center gap-1 ml-auto overflow-x-auto">
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className={`px-2.5 py-1.5 rounded-md font-mono text-[11px] whitespace-nowrap transition-colors ${
                active === s.id
                  ? "bg-ok/12 text-ok border border-ok/30"
                  : "text-mut hover:text-ink border border-transparent"
              }`}
            >
              <span className="opacity-60 mr-1">{s.n}</span>
              {s.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto lg:ml-0 flex items-center gap-2 shrink-0">
          <StatusDot tone="ok" />
          <span className="font-mono text-[10.5px] text-mut hidden sm:inline">
            socle initial prêt
          </span>
        </div>
      </div>
    </header>
  );
}

/* ============================================================
   Ticker Kafka
   ============================================================ */

const TOPICS = [
  "order.created",
  "payment.confirmed",
  "payment.failed",
  "product.created",
  "product.updated",
  "vendor.registered",
  "order.status_changed",
  "customer.registered",
];

function Ticker() {
  const items = [...TOPICS, ...TOPICS];
  return (
    <div className="border-y border-line bg-bg2/60 overflow-hidden">
      <div className="ticker-track flex items-center gap-8 py-2 w-max">
        {items.map((t, i) => (
          <span key={i} className="flex items-center gap-8">
            <span className="font-mono text-[11px] text-warn/80">{t}</span>
            <svg viewBox="0 0 12 12" className="w-2.5 h-2.5 text-dim" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M2 6h7M6.5 3 9.5 6l-3 3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        ))}
      </div>
    </div>
  );
}

/* ============================================================
   Diagramme de services interactif
   ============================================================ */

function MeshDiagram() {
  const [sel, setSel] = useState<Service>(SERVICES[1]);
  const [hov, setHov] = useState<string | null>(null);
  const rowServices = SERVICES.filter((s) => s.y === 130);
  const notification = SERVICES.find((s) => s.id === "notification") as Service;

  const stroke = (s: Service) =>
    sel.id === s.id ? "#4fd68b" : hov === s.id ? "#33463b" : "#24322a";

  return (
    <div className="panel p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="label-mono">Carte du système</p>
          <h3 className="font-display font-bold text-[17px] mt-1">
            7 services, un bus, zéro base partagée
          </h3>
        </div>
        <div className="hidden md:flex flex-col gap-1.5 font-mono text-[10px] text-mut text-right">
          <span className="flex items-center gap-2 justify-end">
            <span className="w-5 h-0 border-t border-dashed border-warn" /> événement Kafka
          </span>
          <span className="flex items-center gap-2 justify-end">
            <span className="w-5 h-0 border-t border-dashed border-infra" /> gRPC synchrone
          </span>
          <span className="flex items-center gap-2 justify-end">
            <span className="w-5 h-0 border-t border-dotted border-dim" /> infra existante
          </span>
        </div>
      </div>

      <svg viewBox="0 0 760 430" className="w-full h-auto select-none" role="img" aria-label="Architecture microservices MIAD Market">
        {/* passerelle → services */}
        {rowServices.map((s) => (
          <line
            key={`gw-${s.id}`}
            x1={380}
            y1={64}
            x2={s.x + NODE_W / 2}
            y2={s.y}
            stroke="#33463b"
            strokeWidth="1"
            opacity="0.55"
          />
        ))}

        {/* publications Kafka */}
        {["auth", "catalog", "vendor", "order", "payment"].map((id, i) => {
          const s = SERVICES.find((x) => x.id === id) as Service;
          const x = s.x + NODE_W / 2 + (id === "payment" ? 14 : 0);
          return (
            <line
              key={`pub-${id}`}
              x1={x}
              y1={176}
              x2={x - (id === "payment" ? 24 : 0)}
              y2={250}
              stroke="#f2b44c"
              strokeWidth="1.3"
              className="edge-flow"
              opacity={0.5 + (i % 2) * 0.2}
            />
          );
        })}

        {/* consumptions Kafka */}
        <path d="M 545 250 C 545 215 556 205 560 180" fill="none" stroke="#f2b44c" strokeWidth="1.4" className="edge-flow-slow" />
        <path d="M 540 284 C 560 322 588 342 630 362" fill="none" stroke="#f2b44c" strokeWidth="1.4" className="edge-flow-slow" />

        {/* gRPC synchrone order ↔ shipping */}
        <line x1={496} y1={153} x2={640} y2={153} stroke="#5fc8de" strokeWidth="1.3" className="edge-flow-slow" />
        <text x={568} y={145} textAnchor="middle" fontFamily="JetBrains Mono" fontSize="8.5" fill="#5fc8de">
          gRPC au checkout
        </text>

        {/* infra existante */}
        <path d="M 50 176 C 18 250 130 330 252 362" fill="none" stroke="#62796e" strokeWidth="1" strokeDasharray="2 5" opacity="0.5" />
        <path d="M 196 176 C 210 270 330 330 425 358" fill="none" stroke="#62796e" strokeWidth="1" strokeDasharray="2 5" opacity="0.5" />
        <line x1={620} y1={162} x2={642} y2={198} stroke="#62796e" strokeWidth="1" strokeDasharray="2 5" opacity="0.7" />

        {/* Vectorize */}
        <line x1={196} y1={130} x2={196} y2={106} stroke="#62796e" strokeWidth="1" strokeDasharray="2 5" opacity="0.7" />
        <rect x={148} y={82} width={96} height={24} rx={6} fill="#101814" stroke="#24322a" />
        <text x={196} y={98} textAnchor="middle" fontFamily="JetBrains Mono" fontSize="9" fill="#8fa59a">
          Vectorize
        </text>

        {/* passerelle */}
        <rect x={310} y={24} width={140} height={40} rx={8} fill="#18231c" stroke="#33463b" />
        <text x={380} y={42} textAnchor="middle" fontFamily="JetBrains Mono" fontSize="11" fontWeight="700" fill="#e9f2ec">
          CADDY
        </text>
        <text x={380} y={55} textAnchor="middle" fontFamily="JetBrains Mono" fontSize="8" fill="#8fa59a">
          passerelle REST/JSON
        </text>

        {/* Stripe / PayDunya */}
        <rect x={628} y={198} width={120} height={26} rx={6} fill="#101814" stroke="#24322a" />
        <text x={688} y={215} textAnchor="middle" fontFamily="JetBrains Mono" fontSize="9" fill="#8fa59a">
          Stripe · PayDunya
        </text>

        {/* barre Kafka */}
        <rect x={90} y={250} width={480} height={34} rx={7} fill="#1a1710" stroke="#f2b44c" strokeOpacity={0.35} />
        <text x={104} y={266} fontFamily="JetBrains Mono" fontSize="10.5" fontWeight="700" fill="#f2b44c">
          KAFKA
        </text>
        <text x={104} y={277} fontFamily="JetBrains Mono" fontSize="7.5" fill="#8fa59a">
          order.created · payment.confirmed · product.updated · vendor.registered · customer.registered
        </text>

        {/* infra du bas */}
        {[
          { x: 40, w: 160, t: "PostgreSQL 16", s: "7 bases dédiées" },
          { x: 240, w: 120, t: "Redis 7", s: "cache + sessions" },
          { x: 400, w: 160, t: "R2 + CDN", s: "existant — inchangé" },
        ].map((b) => (
          <g key={b.t}>
            <rect x={b.x} y={360} width={b.w} height={44} rx={8} fill="#101814" stroke="#24322a" />
            <text x={b.x + 14} y={379} fontFamily="JetBrains Mono" fontSize="10" fontWeight="700" fill="#5fc8de">
              {b.t}
            </text>
            <text x={b.x + 14} y={393} fontFamily="JetBrains Mono" fontSize="8" fill="#62796e">
              {b.s}
            </text>
          </g>
        ))}

        {/* paquets animés */}
        {[
          { d: "M 444 176 L 444 250", dur: "1.9s", begin: "0s" },
          { d: "M 545 250 C 545 215 556 205 560 180", dur: "2.3s", begin: "0.7s" },
          { d: "M 540 284 C 560 322 588 342 630 362", dur: "2.6s", begin: "1.3s" },
          { d: "M 72 176 L 72 250", dur: "2.1s", begin: "1s" },
        ].map((p, i) => (
          <circle key={i} r="2.6" fill="#f2b44c">
            <animateMotion dur={p.dur} begin={p.begin} repeatCount="indefinite" path={p.d} />
          </circle>
        ))}

        {/* nœuds services */}
        {rowServices.map((s) => (
          <g
            key={s.id}
            onClick={() => setSel(s)}
            onMouseEnter={() => setHov(s.id)}
            onMouseLeave={() => setHov(null)}
            className="cursor-pointer"
          >
            <rect
              x={s.x}
              y={s.y}
              width={NODE_W}
              height={NODE_H}
              rx={8}
              fill={sel.id === s.id ? "#1d2a22" : "#141d18"}
              stroke={stroke(s)}
              strokeWidth={sel.id === s.id ? 1.6 : 1}
            />
            <text x={s.x + NODE_W / 2} y={s.y + 20} textAnchor="middle" fontFamily="JetBrains Mono" fontSize="10.5" fontWeight="700" fill="#e9f2ec">
              {s.name}
            </text>
            <text x={s.x + NODE_W / 2} y={s.y + 35} textAnchor="middle" fontFamily="JetBrains Mono" fontSize="8.5" fill="#62796e">
              :{s.port}
            </text>
          </g>
        ))}

        {/* notification-svc */}
        <g
          onClick={() => setSel(notification)}
          onMouseEnter={() => setHov(notification.id)}
          onMouseLeave={() => setHov(null)}
          className="cursor-pointer"
        >
          <rect
            x={notification.x}
            y={notification.y}
            width={150}
            height={44}
            rx={8}
            fill={sel.id === notification.id ? "#1d2a22" : "#141d18"}
            stroke={stroke(notification)}
            strokeWidth={sel.id === notification.id ? 1.6 : 1}
          />
          <text x={notification.x + 75} y={notification.y + 19} textAnchor="middle" fontFamily="JetBrains Mono" fontSize="10.5" fontWeight="700" fill="#e9f2ec">
            notification-svc
          </text>
          <text x={notification.x + 75} y={notification.y + 34} textAnchor="middle" fontFamily="JetBrains Mono" fontSize="8.5" fill="#62796e">
            consommateur pur · :8087
          </text>
        </g>
      </svg>

      {/* fiche du service sélectionné */}
      <div className="grid md:grid-cols-[1.2fr_1fr] gap-4">
        <div className="bg-bg2/70 border border-line rounded-lg p-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="font-mono text-[13px] font-bold text-ok">{sel.name}</p>
            <div className="flex gap-2">
              <span className="chip">:{sel.port}</span>
              <span className="chip !text-infra !border-infra/30">{sel.db}</span>
            </div>
          </div>
          <p className="text-[13px] text-mut leading-relaxed mt-2">{sel.role}</p>
          <div className="flex flex-wrap gap-1.5 mt-3">
            {sel.tables.map((t) => (
              <span key={t} className="chip !text-ink">{t}</span>
            ))}
          </div>
        </div>
        <div className="bg-bg2/70 border border-line rounded-lg p-4 space-y-3">
          <div>
            <p className="label-mono mb-1.5">Publie</p>
            {sel.publishes.length ? (
              <div className="flex flex-wrap gap-1.5">
                {sel.publishes.map((t) => (
                  <span key={t} className="chip !text-warn !border-warn/30">{t}</span>
                ))}
              </div>
            ) : (
              <p className="font-mono text-[11px] text-dim">— rien (appelé en synchrone ou consommateur)</p>
            )}
          </div>
          <div>
            <p className="label-mono mb-1.5">Consomme</p>
            {sel.consumes.length ? (
              <div className="flex flex-wrap gap-1.5">
                {sel.consumes.map((t) => (
                  <span key={t} className="chip !text-warn !border-warn/30">{t}</span>
                ))}
              </div>
            ) : (
              <p className="font-mono text-[11px] text-dim">— aucun topic</p>
            )}
          </div>
          <div>
            <p className="label-mono mb-1.5">Extrait du contrat</p>
            <div className="space-y-1">
              {sel.sample.map((e) => (
                <p key={e} className="font-mono text-[11px] text-ink/85">{e}</p>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   System-check en direct (simulation fidèle au script réel)
   ============================================================ */

interface CheckRow {
  id: string;
  port: string;
  status: "scan" | "ok";
  checks: { label: string; base: number; kind: "ms" | "state" }[];
}

const BASE_ROWS: Omit<CheckRow, "status">[] = [
  { id: "catalog-svc", port: "8081", checks: [{ label: "postgres", base: 3, kind: "ms" }, { label: "kafka pub", base: 0, kind: "state" }] },
  { id: "vendor-svc", port: "8082", checks: [{ label: "postgres", base: 2, kind: "ms" }, { label: "kafka pub", base: 0, kind: "state" }] },
  { id: "order-svc", port: "8083", checks: [{ label: "postgres", base: 4, kind: "ms" }, { label: "kafka pub", base: 0, kind: "state" }, { label: "reaper", base: 0, kind: "state" }] },
  { id: "payment-svc", port: "8084", checks: [{ label: "postgres", base: 3, kind: "ms" }, { label: "kafka conso", base: 0, kind: "state" }, { label: "stripe", base: 0, kind: "state" }] },
  { id: "shipping-svc", port: "8085", checks: [{ label: "postgres", base: 2, kind: "ms" }] },
  { id: "auth-svc", port: "8086", checks: [{ label: "postgres", base: 3, kind: "ms" }, { label: "redis", base: 1, kind: "ms" }, { label: "jwt", base: 0, kind: "state" }] },
  { id: "notification-svc", port: "8087", checks: [{ label: "postgres", base: 2, kind: "ms" }, { label: "kafka conso", base: 0, kind: "state" }] },
];

function jitter(base: number, kind: "ms" | "state") {
  return kind === "ms" ? Math.max(1, base + Math.round(Math.random() * 4)) : 0;
}

function SystemCheck() {
  const [rows, setRows] = useState<CheckRow[]>(() =>
    BASE_ROWS.map((r) => ({ ...r, status: "scan", checks: r.checks.map((c) => ({ ...c })) }))
  );
  const timers = useRef<number[]>([]);

  const run = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setRows(BASE_ROWS.map((r) => ({ ...r, status: "scan", checks: r.checks.map((c) => ({ ...c })) })));
    BASE_ROWS.forEach((r, i) => {
      const t = window.setTimeout(() => {
        setRows((prev) =>
          prev.map((p) =>
            p.id === r.id
              ? { ...p, status: "ok", checks: p.checks.map((c) => ({ ...c, base: jitter(c.base, c.kind) })) }
              : p
          )
        );
      }, 420 + i * 190);
      timers.current.push(t);
    });
  };

  useEffect(() => {
    run();
    const iv = window.setInterval(() => {
      setRows((prev) =>
        prev.map((r) =>
          r.status === "ok"
            ? { ...r, checks: r.checks.map((c) => ({ ...c, base: jitter(c.base, c.kind) })) }
            : r
        )
      );
    }, 2600);
    return () => {
      clearInterval(iv);
      timers.current.forEach(clearTimeout);
    };
  }, []);

  const allOk = rows.every((r) => r.status === "ok");

  return (
    <div className="panel p-5 flex flex-col">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div>
          <p className="label-mono">scripts/system-check.sh</p>
          <h3 className="font-display font-bold text-[17px] mt-1">
            /admin/system-check
          </h3>
        </div>
        <button
          onClick={run}
          className="chip cursor-pointer hover:!border-ok/50 hover:!text-ok transition-colors"
        >
          <svg viewBox="0 0 12 12" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <path d="M10.5 6a4.5 4.5 0 1 1-1.3-3.2M10.5 1.5v2.3H8.2" />
          </svg>
          Relancer
        </button>
      </div>

      <div className="code-block p-3.5 flex-1">
        <p className="text-dim mb-2">
          <span className="text-ok">$</span> bash scripts/system-check.sh
        </p>
        <div className="space-y-1.5">
          {rows.map((r) => (
            <div key={r.id} className="flex items-center gap-2.5 flex-wrap">
              <span className={r.status === "ok" ? "text-ok" : "text-warn cursor-blink"}>
                {r.status === "ok" ? "✔" : "▸"}
              </span>
              <span className="text-ink/90 w-[122px]">{r.id}</span>
              <span className="text-dim">:{r.port}</span>
              {r.status === "ok" ? (
                <span className="flex gap-1.5 flex-wrap">
                  {r.checks.map((c) => (
                    <span key={c.label} className="text-mut">
                      {c.label}
                      <span className="text-ok">
                        {c.kind === "ms" ? ` ${c.base}ms` : " ok"}
                      </span>
                    </span>
                  ))}
                </span>
              ) : (
                <span className="text-dim">sonde en cours…</span>
              )}
            </div>
          ))}
        </div>
        <p className="mt-3 pt-3 border-t border-line text-[11px]">
          {allOk ? (
            <span className="text-ok">TOUS LES SERVICES SONT OK — agrégé depuis les 7 ports</span>
          ) : (
            <span className="text-warn">balayage des 7 services en cours…</span>
          )}
        </p>
      </div>
      <p className="text-[12px] text-dim mt-3 leading-relaxed">
        Simulation fidèle du script du dépôt : chaque service expose{" "}
        <code className="font-mono text-mut">/system-check</code> avec le détail par
        dépendance (Postgres, Kafka, Redis, Stripe…). Sous WordPress, cet état n'existait
        nulle part.
      </p>
    </div>
  );
}

/* ============================================================
   Sections
   ============================================================ */

function IncidentCard({ inc, i }: { inc: (typeof INCIDENTS)[number]; i: number }) {
  const tone = inc.tone === "alert" ? "text-alert border-alert/40 bg-alert/10" : "text-warn border-warn/40 bg-warn/10";
  return (
    <Reveal delay={i * 90}>
      <article className="panel panel-hover p-5 h-full flex flex-col">
        <div className="flex items-center justify-between gap-3 mb-3">
          <span className="font-mono text-[11px] text-dim">{inc.date}</span>
          <span className={`font-mono text-[10.5px] px-2 py-0.5 rounded-full border ${tone}`}>{inc.tag}</span>
        </div>
        <h3 className="font-display font-bold text-[17px] mb-2">{inc.title}</h3>
        <p className="text-[13.5px] text-mut leading-relaxed flex-1">{inc.body}</p>
        <div className="mt-4 pt-3 border-t border-line">
          <p className="label-mono mb-1.5">Réponse du nouveau backend</p>
          <p className="text-[13px] text-ok/90 leading-relaxed">{inc.fix}</p>
        </div>
      </article>
    </Reveal>
  );
}

function EndpointBrowser() {
  const tabs = ["catalog-svc", "vendor-svc", "order-svc", "payment-svc", "shipping-svc", "auth-svc", "transverse"];
  const [tab, setTab] = useState("catalog-svc");
  const list = ENDPOINTS.filter((e) => e.svc === tab);

  return (
    <div className="panel overflow-hidden">
      <div className="flex items-center gap-1.5 p-3 border-b border-line overflow-x-auto">
        {tabs.map((t) => {
          const count = ENDPOINTS.filter((e) => e.svc === t).length;
          return (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 rounded-md font-mono text-[11.5px] whitespace-nowrap transition-colors cursor-pointer ${
                tab === t
                  ? "bg-ok/12 text-ok border border-ok/30"
                  : "text-mut border border-transparent hover:text-ink"
              }`}
            >
              {t} <span className="opacity-50">{count}</span>
            </button>
          );
        })}
      </div>
      <div className="divide-y divide-line">
        {list.map((e) => (
          <div key={e.method + e.path} className="row-hover flex items-start gap-4 px-4 py-3">
            <MethodChip method={e.method} />
            <div className="min-w-0">
              <p className="font-mono text-[13px] text-ink">{e.path}</p>
              <p className="text-[12.5px] text-mut mt-0.5 leading-relaxed">{e.desc}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="px-4 py-3 border-t border-line bg-bg2/60 flex items-center justify-between gap-3 flex-wrap">
        <p className="text-[12px] text-dim">
          Même contrat JSON que les routes Next.js actuelles — seule l'URL cible change.
        </p>
        <span className="chip">~80 routes au total dans app/api/**</span>
      </div>
    </div>
  );
}

function MigrationTimeline() {
  const [open, setOpen] = useState(0);
  return (
    <div className="relative">
      <span className="absolute left-[27px] top-3 bottom-3 w-px bg-line2 hidden sm:block" />
      <div className="space-y-3">
        {PHASES.map((p, i) => {
          const active = open === i;
          return (
            <Reveal key={p.n} delay={i * 60}>
              <button
                onClick={() => setOpen(active ? -1 : i)}
                className={`w-full text-left panel panel-hover p-4 sm:p-5 flex gap-4 sm:gap-5 items-start cursor-pointer transition-colors ${
                  active ? "!border-ok/40" : ""
                }`}
              >
                <span
                  className={`relative z-10 shrink-0 w-9 h-9 rounded-lg grid place-items-center font-mono text-[12px] font-bold border ${
                    active ? "bg-ok/15 border-ok/50 text-ok" : "bg-bg2 border-line2 text-mut"
                  }`}
                >
                  {p.n}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="flex items-center justify-between gap-3">
                    <span className="font-display font-bold text-[16px]">{p.title}</span>
                    <svg
                      viewBox="0 0 12 12"
                      className={`w-3.5 h-3.5 text-mut transition-transform ${active ? "rotate-45" : ""}`}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    >
                      <path d="M6 2v8M2 6h8" />
                    </svg>
                  </span>
                  <span
                    className={`grid transition-all duration-300 ${active ? "grid-rows-[1fr] opacity-100 mt-2" : "grid-rows-[0fr] opacity-0"}`}
                  >
                    <span className="overflow-hidden block">
                      <span className="block text-[13.5px] text-mut leading-relaxed">{p.body}</span>
                      <span className="block mt-3 font-mono text-[11.5px] text-warn/90 border-l-2 border-warn/50 pl-3">
                        {p.gate}
                      </span>
                    </span>
                  </span>
                </span>
              </button>
            </Reveal>
          );
        })}
      </div>
    </div>
  );
}

/* ============================================================
   Checklist « je fais quoi maintenant » — persistance locale
   ============================================================ */

const CHECK_KEY = "miad-now-checklist";

/* ---------- Panneau d'accès SSH au VPS ---------- */

function SshPanel() {
  const [pwd, setPwd] = useState("");
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);
  const sshCmd = `ssh ${VPS_ACCESS.user}@${VPS_ACCESS.host}`;

  const copyPwd = async () => {
    if (!pwd) return;
    try {
      await navigator.clipboard.writeText(pwd);
    } catch {
      /* silencieux */
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="panel overflow-hidden mb-5">
      <div className="px-4 py-3 border-b border-line bg-bg2/60 flex items-center justify-between gap-3 flex-wrap">
        <span className="label-mono !text-ink">Accès SSH au VPS</span>
        <span className="chip !text-ok !border-ok/40">
          <StatusDot tone="ok" />
          k3s cible
        </span>
      </div>
      <div className="p-4 grid lg:grid-cols-2 gap-4">
        <div>
          <div className="code-block p-3.5 flex items-center justify-between gap-3">
            <p className="text-[13px]">
              <span className="text-ok">$</span> {sshCmd}
            </p>
            <CopyButton text={sshCmd} label="" />
          </div>
          <div className="flex items-center gap-2 mt-3">
            <input
              type={show ? "text" : "password"}
              value={pwd}
              onChange={(e) => setPwd(e.target.value)}
              placeholder="Mot de passe (saisir pour copier — ni stocké, ni envoyé)"
              className="flex-1 bg-bg2 border border-line rounded-md px-3 py-2 font-mono text-[12.5px] text-ink placeholder:text-dim outline-none focus:border-ok/50 transition-colors"
            />
            <button
              onClick={() => setShow((v) => !v)}
              className="chip cursor-pointer hover:!border-line2 hover:!text-ink transition-colors"
              title={show ? "Masquer" : "Afficher"}
            >
              {show ? (
                <svg viewBox="0 0 14 14" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
                  <path d="M2 7s2-3.5 5-3.5S12 7 12 7s-2 3.5-5 3.5S2 7 2 7Z" />
                  <circle cx="7" cy="7" r="1.4" />
                  <path d="m2.5 11.5 9-9" />
                </svg>
              ) : (
                <svg viewBox="0 0 14 14" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
                  <path d="M2 7s2-3.5 5-3.5S12 7 12 7s-2 3.5-5 3.5S2 7 2 7Z" />
                  <circle cx="7" cy="7" r="1.4" />
                </svg>
              )}
            </button>
            <button
              onClick={copyPwd}
              className={`chip cursor-pointer transition-colors ${
                copied ? "!text-ok !border-ok/50" : "hover:!border-line2 hover:!text-ink"
              }`}
            >
              {copied ? "Copié" : "Copier"}
            </button>
          </div>
          <div className="mt-3 border border-alert/35 bg-alert/8 rounded-lg px-3.5 py-2.5">
            <p className="text-[12px] text-alert/95 leading-relaxed">
              <span className="font-mono font-bold">Sécurité :</span> ce mot de passe a circulé
              dans une conversation — il est compromis. Une fois connecté :{" "}
              <code className="font-mono text-[11px]">passwd</code> pour en poser un nouveau, puis{" "}
              <code className="font-mono text-[11px]">ssh-copy-id miad@{VPS_ACCESS.host}</code>{" "}
              pour basculer sur clé SSH et couper l'accès par mot de passe.
            </p>
          </div>
        </div>
        <div className="border border-infra/30 bg-infra/5 rounded-lg px-4 py-3.5">
          <p className="label-mono !text-infra mb-2">Adresse Tailscale détectée</p>
          <p className="text-[12.5px] text-mut leading-relaxed">{VPS_ACCESS.tailscale}</p>
          <p className="font-mono text-[11px] text-dim mt-3">
            → le frontend et toi y accédez via le tailnet ; la CI aura besoin d'un pont (voir étape 08).
          </p>
        </div>
      </div>
    </div>
  );
}

/* ---------- Transfert du code vers le VPS ---------- */

function TransferPanel() {
  const [tab, setTab] = useState(TRANSFER[0].id);
  const active = TRANSFER.find((t) => t.id === tab) ?? TRANSFER[0];

  return (
    <div className="panel overflow-hidden mb-5">
      <div className="px-4 py-3 border-b border-line bg-bg2/60 flex items-center justify-between gap-3 flex-wrap">
        <span className="label-mono !text-ink">Faire arriver le code sur le VPS</span>
        <div className="flex gap-1.5">
          {TRANSFER.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-3 py-1 rounded-md font-mono text-[11px] cursor-pointer transition-colors border ${
                tab === t.id
                  ? "bg-ok/12 text-ok border-ok/35"
                  : "text-mut border-transparent hover:text-ink"
              }`}
            >
              {t.badge}
            </button>
          ))}
        </div>
      </div>
      <div className="p-4 space-y-4">
        <p className="font-display font-bold text-[15px]">{active.title}</p>
        {active.steps.map((s, i) => (
          <div key={i}>
            <p className="text-[12.5px] text-mut leading-relaxed mb-2">
              <span className="font-mono text-[11px] text-ok mr-1.5">{String(i + 1).padStart(2, "0")}</span>
              {s.label}
            </p>
            <div className="code-block p-3.5 flex items-start justify-between gap-3">
              <code className="text-[12px] text-ink/90 whitespace-pre-wrap break-all leading-relaxed">
                {s.cmd}
              </code>
              <span className="shrink-0">
                <CopyButton text={s.cmd} label="" />
              </span>
            </div>
          </div>
        ))}
        <p className="font-mono text-[11px] text-dim leading-relaxed pt-1">
          {active.note}
        </p>
      </div>
    </div>
  );
}

function NowChecklist() {
  const [done, setDone] = useState<boolean[]>(() => {
    try {
      const raw = localStorage.getItem(CHECK_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as boolean[];
        if (Array.isArray(parsed) && parsed.length === NOW_STEPS.length) return parsed;
      }
    } catch {
      /* stockage indisponible : on repart à zéro */
    }
    return NOW_STEPS.map(() => false);
  });

  const toggle = (i: number) => {
    setDone((prev) => {
      const next = prev.map((v, j) => (j === i ? !v : v));
      try {
        localStorage.setItem(CHECK_KEY, JSON.stringify(next));
      } catch {
        /* silencieux */
      }
      return next;
    });
  };

  const count = done.filter(Boolean).length;
  const pct = Math.round((count / NOW_STEPS.length) * 100);

  return (
    <div className="panel p-5">
      <div className="flex items-center justify-between gap-3 mb-1">
        <div>
          <p className="label-mono">Feuille de route</p>
          <h3 className="font-display font-bold text-[17px] mt-1">Je fais quoi maintenant ?</h3>
        </div>
        <span className="font-mono text-[12px] text-ok shrink-0">
          {count}/{NOW_STEPS.length}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-line overflow-hidden mb-5">
        <div
          className="h-full rounded-full bg-ok transition-all duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>

      <ol className="space-y-2.5">
        {NOW_STEPS.map((s, i) => {
          const isDone = done[i];
          return (
            <li
              key={s.title}
              className={`rounded-lg border transition-colors ${
                isDone ? "border-ok/35 bg-ok/5" : "border-line bg-bg2/60"
              }`}
            >
              <button
                onClick={() => toggle(i)}
                className="w-full text-left flex items-start gap-3 p-3.5 cursor-pointer group"
              >
                <span
                  className={`shrink-0 w-5 h-5 rounded-md grid place-items-center border transition-all mt-0.5 ${
                    isDone
                      ? "bg-ok border-ok text-bg"
                      : "border-line2 text-transparent group-hover:border-ok/50"
                  }`}
                >
                  <svg viewBox="0 0 12 12" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2 6.5 4.5 9 10 3" />
                  </svg>
                </span>
                <span className="flex-1 min-w-0">
                  <span className="flex items-center justify-between gap-3 flex-wrap">
                    <span className={`font-display font-bold text-[14px] ${isDone ? "text-mut line-through decoration-ok/50" : ""}`}>
                      <span className={`font-mono text-[11px] mr-2 ${s.alert ? "text-alert" : "text-ok"}`}>
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      {s.title}
                    </span>
                    <span className="flex items-center gap-1.5">
                      {s.alert && !isDone && (
                        <span className="chip !text-[10px] !text-alert !border-alert/40">prioritaire</span>
                      )}
                      <span className="chip !text-[10px]">{s.where}</span>
                    </span>
                  </span>
                  <span className={`block text-[12.5px] leading-relaxed mt-1 ${isDone ? "text-dim" : "text-mut"}`}>
                    {s.body}
                  </span>
                  {s.cmd && !isDone && (
                    <span
                      className="flex items-start justify-between gap-3 mt-2 code-block p-2.5 !text-[11.5px]"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <code className="text-ink/90 whitespace-pre-wrap break-all leading-relaxed">{s.cmd}</code>
                      <span className="shrink-0">
                        <CopyButton text={s.cmd} label="" />
                      </span>
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <p className="text-[12px] text-dim mt-4 leading-relaxed">
        Ta progression est enregistrée sur cet appareil — coche au fur et à mesure.
        {count === NOW_STEPS.length && (
          <span className="block text-ok mt-1.5 font-mono text-[12px]">
            ✔ Stack en ligne. Prochaine étape : plan de migration, phase 02 (import WooCommerce).
          </span>
        )}
      </p>
    </div>
  );
}

/* ============================================================
   App
   ============================================================ */

export default function App() {
  return (
    <div className="min-h-screen">
      <TopBar />
      <Ticker />

      {/* ---------- 00 · Console d'ouverture ---------- */}
      <section id="board" className="max-w-[1200px] mx-auto px-5 pt-12 pb-16 scroll-mt-20">
        <div className="grid lg:grid-cols-[1.15fr_1fr] gap-10 items-end mb-10">
          <Reveal>
            <p className="label-mono mb-4">Brief technique · marketplace e-commerce africaine</p>
            <h1 className="h-display text-[clamp(2.3rem,6vw,4.2rem)] uppercase">
              Backend
              <span className="text-ok"> sans</span>
              <br />
              WordPress<span className="text-ok">.</span>
            </h1>
          </Reveal>
          <Reveal delay={120}>
            <div className="grid grid-cols-1 gap-2.5 text-[13px]">
              <div className="flex items-center justify-between gap-4 panel px-4 py-3">
                <span className="text-mut">Aujourd'hui</span>
                <span className="font-mono text-[12px] text-alert/90 text-right">WordPress · WooCommerce · Dokan · WPML</span>
              </div>
              <div className="flex items-center justify-between gap-4 panel px-4 py-3">
                <span className="text-mut">Cible</span>
                <span className="font-mono text-[12px] text-ok text-right">Go · gRPC · Kafka · Postgres — sur VPS</span>
              </div>
              <div className="flex items-center justify-between gap-4 panel px-4 py-3">
                <span className="text-mut">Frontend</span>
                <span className="font-mono text-[12px] text-ink text-right">Next.js 15 — inchangé</span>
              </div>
            </div>
          </Reveal>
        </div>

        <div className="grid lg:grid-cols-[1.35fr_1fr] gap-5 items-stretch">
          <Reveal className="h-full">
            <MeshDiagram />
          </Reveal>
          <Reveal delay={120} className="h-full">
            <SystemCheck />
          </Reveal>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-5">
          {STATS.map((s, i) => (
            <Reveal key={s.label} delay={i * 70}>
              <div className="panel px-4 py-4">
                <Counter
                  value={s.value}
                  suffix={s.suffix}
                  className="font-display font-extrabold text-[26px] text-ink"
                />
                <p className="text-[12px] text-mut mt-1 leading-snug">{s.label}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ---------- 01 · Pourquoi partir ---------- */}
      <section id="incidents" className="max-w-[1200px] mx-auto px-5 py-16 border-t border-line scroll-mt-16">
        <SectionHead
          num="01"
          kicker="Cadrage"
          title="Pourquoi partir"
          lead="Pas une préférence théorique — trois incidents réels sur ce projet, tous causés par la façon dont WordPress/SiteGround gère les requêtes API. Point commun : le backend actuel échoue sans le dire."
        />
        <div className="grid md:grid-cols-3 gap-4">
          {INCIDENTS.map((inc, i) => (
            <IncidentCard key={inc.title} inc={inc} i={i} />
          ))}
        </div>
      </section>

      {/* ---------- 02 · Objectifs & contraintes ---------- */}
      <section id="objectifs" className="max-w-[1200px] mx-auto px-5 py-16 border-t border-line scroll-mt-16">
        <SectionHead num="02" kicker="Cadrage" title="Objectifs & contraintes" />
        <div className="grid md:grid-cols-2 gap-4">
          <Reveal>
            <div className="panel p-5 h-full">
              <p className="label-mono mb-4 !text-ok">Objectifs</p>
              <ul className="space-y-3">
                {GOALS.map((g) => (
                  <li key={g} className="flex gap-3 text-[13.5px] leading-relaxed">
                    <svg viewBox="0 0 12 12" className="w-4 h-4 text-ok shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2 6.5 4.5 9 10 3" />
                    </svg>
                    <span className="text-ink/90">{g}</span>
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
          <Reveal delay={100}>
            <div className="panel p-5 h-full !border-warn/30">
              <p className="label-mono mb-4 !text-warn">Contraintes dures</p>
              <ul className="space-y-3">
                {CONSTRAINTS.map((c) => (
                  <li key={c} className="flex gap-3 text-[13.5px] leading-relaxed">
                    <svg viewBox="0 0 12 12" className="w-4 h-4 text-warn shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                      <rect x="2.5" y="5" width="7" height="5" rx="1" />
                      <path d="M4 5V3.8a2 2 0 0 1 4 0V5" />
                    </svg>
                    <span className="text-ink/90">{c}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-5 pt-4 border-t border-line">
                <p className="font-mono text-[11.5px] text-mut leading-relaxed">
                  <span className="text-warn">Contrainte de migration :</span> le catalogue,
                  les boutiques et les commandes existent déjà — le nouveau backend les{" "}
                  <span className="text-ink">importe</span> (export CSV/API WooCommerce
                  ponctuel), il ne les recrée pas. Voir section 07.
                </p>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ---------- 03 · Stack ---------- */}
      <section id="stack" className="max-w-[1200px] mx-auto px-5 py-16 border-t border-line scroll-mt-16">
        <SectionHead
          num="03"
          kicker="Cadrage"
          title="Stack proposée"
          lead="Microservices Go : chaque domaine métier est un service indépendant, communication interne en gRPC, événements asynchrones via Kafka, cache Redis, CDN devant les assets. Choix assumé : plus de pièces mobiles qu'un simple Worker, mais un modèle standard, scalable service par service."
        />
        <div className="grid lg:grid-cols-[1.4fr_1fr] gap-4">
          <Reveal>
            <div className="panel overflow-hidden">
              {STACK.map((s, i) => (
                <div
                  key={s.layer}
                  className={`row-hover flex items-center gap-4 px-4 py-3 ${i > 0 ? "border-t border-line" : ""}`}
                >
                  <span className="w-[150px] shrink-0 text-[12.5px] text-mut">{s.layer}</span>
                  <span className="font-mono text-[13px] text-ok w-[170px] shrink-0">{s.choice}</span>
                  <span className="text-[12.5px] text-mut leading-snug hidden sm:block">{s.why}</span>
                </div>
              ))}
              <div className="px-4 py-3.5 border-t border-line bg-bg2/60">
                <p className="font-mono text-[11.5px] text-mut leading-relaxed">
                  <span className="text-warn">Compromis assumé :</span> Kafka et Postgres ont
                  besoin de vrai calcul — VPS + Docker Compose pour démarrer, Kafka et Redis
                  pouvant rester managés (Upstash) pour réduire l'opérationnel.
                </p>
              </div>
            </div>
          </Reveal>
          <div className="space-y-4">
            <Reveal delay={80}>
              <div className="panel p-5">
                <p className="label-mono mb-3 !text-ok">Ce qui reste identique</p>
                <ul className="space-y-2.5">
                  {LEDGER.kept.map(([k, v]) => (
                    <li key={k} className="text-[13px] leading-snug">
                      <span className="text-ink">{k}</span>
                      <span className="text-dim"> — {v}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </Reveal>
            <Reveal delay={160}>
              <div className="panel p-5 !border-alert/25">
                <p className="label-mono mb-3 !text-alert">Ce qui est retiré</p>
                <ul className="space-y-2.5">
                  {LEDGER.dropped.map(([k, v]) => (
                    <li key={k} className="text-[13px] leading-snug">
                      <span className="text-ink/80 line-through decoration-alert/60">{k}</span>
                      <span className="text-dim"> — {v}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ---------- 04 · Modèle de données ---------- */}
      <section id="data" className="max-w-[1200px] mx-auto px-5 py-16 border-t border-line scroll-mt-16">
        <SectionHead
          num="04"
          kicker="Conception"
          title="Modèle de données"
          lead="Chaque table appartient à un seul service, sur sa propre base Postgres. Un service qui a besoin d'une donnée d'un autre l'appelle en gRPC (temps réel) ou la reconstruit depuis un événement Kafka (vue en cache, éventuellement consistante)."
        />
        <div className="grid md:grid-cols-2 gap-3 mb-6">
          {TABLES.map((t, i) => (
            <Reveal key={t.name} delay={(i % 4) * 60}>
              <div className="panel panel-hover px-4 py-3.5 h-full">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-mono text-[13px] font-bold text-ink">{t.name}</p>
                  <span className="chip !text-infra !border-infra/30">{t.svc}</span>
                </div>
                <p className="text-[12.5px] text-mut mt-1.5 leading-relaxed">{t.content}</p>
              </div>
            </Reveal>
          ))}
        </div>
        <div className="grid lg:grid-cols-2 gap-4">
          <Reveal>
            <div className="panel p-5">
              <p className="label-mono mb-4">Point d'attention — traduction</p>
              <div className="flex items-center gap-3">
                <div className="flex-1 code-block p-3 text-[11.5px]">
                  <p className="text-dim">products</p>
                  <p><span className="text-infra">id</span> 201 · <span className="text-warn">trid</span> t-77 · <span className="text-ok">lang</span> fr</p>
                  <p className="text-ink/85">« Sac en cuir de Katiola »</p>
                </div>
                <svg viewBox="0 0 40 20" className="w-10 h-5 text-warn shrink-0" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                  <path d="M4 10h28M26 4l8 6-8 6" />
                </svg>
                <div className="flex-1 code-block p-3 text-[11.5px]">
                  <p className="text-dim">products</p>
                  <p><span className="text-infra">id</span> 202 · <span className="text-warn">trid</span> t-77 · <span className="text-ok">lang</span> en</p>
                  <p className="text-ink/85">"Katiola leather bag"</p>
                </div>
              </div>
              <p className="text-[13px] text-mut leading-relaxed mt-4">
                Le modèle WPML (une ligne par langue, liées par un <span className="font-mono text-warn">trid</span> partagé)
                est conservé <span className="text-ink">tel quel</span> — pas de colonnes name_fr/name_en côte à côte —
                pour que l'import depuis WooCommerce soit une copie directe, sans transformation.
              </p>
            </div>
          </Reveal>
          <Reveal delay={100}>
            <div className="panel p-5 !border-warn/25">
              <p className="label-mono mb-4 !text-warn">Point d'attention — cohérence</p>
              <p className="text-[13.5px] text-mut leading-relaxed">
                order-svc ne connaît pas le détail du paiement, payment-svc ne connaît pas le
                détail de la commande : cohérence éventuelle via Kafka, pas de transaction SQL
                entre les deux. Le cas d'échec partiel est géré explicitement :
              </p>
              <div className="code-block p-3.5 mt-4 text-[11.5px]">
                <p className="text-mut">commande créée → payment.confirmed jamais reçu ?</p>
                <p className="text-warn">statut pending_payment</p>
                <p className="text-ok">reaper order-svc → payment_expired après 30 min</p>
                <p className="text-mut mt-1">notification-svc en panne → rattrapage via offsets Kafka</p>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ---------- 05 · Surface API ---------- */}
      <section id="api" className="max-w-[1200px] mx-auto px-5 py-16 border-t border-line scroll-mt-16">
        <SectionHead
          num="05"
          kicker="Conception"
          title="Surface API"
          lead="La passerelle grpc-gateway répond au même contrat JSON : app/api/* n'a quasiment rien à changer — seule l'URL cible bouge (WOO_URL → passerelle). Chaque groupe correspond à un fichier .proto par service."
        />
        <Reveal>
          <EndpointBrowser />
        </Reveal>
      </section>

      {/* ---------- 06 · Fonctionnalités ---------- */}
      <section id="features" className="max-w-[1200px] mx-auto px-5 py-16 border-t border-line scroll-mt-16">
        <SectionHead
          num="06"
          kicker="Conception"
          title="Fonctionnalités à ne pas perdre"
          lead="100 % du périmètre existant doit survivre à la bascule — aucune régression visible côté acheteur ou vendeur."
        />
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
          {FEATURES.map((f, i) => (
            <Reveal key={f.title} delay={(i % 3) * 70}>
              <div className="panel panel-hover p-5 h-full">
                <div className="flex items-center gap-3 mb-2.5">
                  <span className="w-9 h-9 rounded-lg bg-ok/10 border border-ok/25 grid place-items-center">
                    <Glyph name={["store", "globe", "layers", "truck", "card", "search", "board", "shield", "bell"][i]} />
                  </span>
                  <h3 className="font-display font-bold text-[15px] leading-tight">{f.title}</h3>
                </div>
                <p className="text-[13px] text-mut leading-relaxed">{f.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ---------- 07 · Migration ---------- */}
      <section id="migration" className="max-w-[1200px] mx-auto px-5 py-16 border-t border-line scroll-mt-16">
        <SectionHead
          num="07"
          kicker="Exécution"
          title="Plan de migration en 6 phases"
          lead="Progressive, jamais un big-bang — le site actuel reste la source de vérité jusqu'à la bascule finale confirmée. Chaque phase a sa gate explicite."
        />
        <MigrationTimeline />
      </section>

      {/* ---------- 08 · Hors périmètre ---------- */}
      <section className="max-w-[1200px] mx-auto px-5 py-16 border-t border-line">
        <SectionHead num="08" kicker="Exécution" title="Hors périmètre" />
        <div className="grid sm:grid-cols-2 gap-3">
          {OUT_OF_SCOPE.map((o, i) => (
            <Reveal key={o} delay={(i % 2) * 70}>
              <div className="panel px-4 py-3.5 flex items-start gap-3">
                <svg viewBox="0 0 12 12" className="w-4 h-4 text-dim shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <circle cx="6" cy="6" r="4.5" />
                  <path d="M3.5 3.5 8.5 8.5" />
                </svg>
                <p className="text-[13.5px] text-mut leading-relaxed">{o}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ---------- 09 · Prompt ---------- */}
      <section id="prompt" className="max-w-[1200px] mx-auto px-5 py-16 border-t border-line scroll-mt-16">
        <SectionHead
          num="09"
          kicker="Exécution"
          title="Le prompt à utiliser"
          lead="À copier tel quel comme premier message à un agent de code disposant d'un accès au dépôt."
        />
        <Reveal>
          <div className="panel overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-line bg-bg2/60">
              <span className="font-mono text-[11px] text-mut">brief-agent.md — premier message</span>
              <CopyButton text={PROMPT} />
            </div>
            <pre className="code-block !border-0 !rounded-none p-5 whitespace-pre-wrap text-[12px] leading-relaxed text-ink/85 max-h-[440px] overflow-y-auto">
              {PROMPT}
            </pre>
          </div>
        </Reveal>
      </section>

      {/* ---------- 10 · Déploiement VPS ---------- */}
      <section id="vps" className="max-w-[1200px] mx-auto px-5 py-16 border-t border-line scroll-mt-16">
        <SectionHead
          num="10"
          kicker="Exécution"
          title="Déploiement VPS — option Compose"
          lead="Le mode Kubernetes (k3s) est le chemin principal — section 12. Cette pile Compose reste le repli local ou VPS : mêmes services, mêmes noms, même .env, rien n'est verrouillé."
        />
        <div className="grid md:grid-cols-2 gap-3 mb-5">
          {DEPLOY_STEPS.map((s, i) => (
            <Reveal key={s.cmd} delay={(i % 2) * 70}>
              <CmdBlock n={i + 1} cmd={s.cmd} note={s.note} />
            </Reveal>
          ))}
        </div>
        <div className="grid lg:grid-cols-[1.3fr_1fr] gap-4">
          <Reveal>
            <div className="panel overflow-hidden">
              <p className="label-mono px-4 py-3 border-b border-line">Ce que monte docker compose</p>
              {COMPOSE_STACK.map((c, i) => (
                <div key={c.c} className={`row-hover flex items-center gap-4 px-4 py-3 ${i > 0 ? "border-t border-line" : ""}`}>
                  <span className="font-mono text-[12.5px] text-infra w-[150px] shrink-0">{c.c}</span>
                  <span className="text-[12.5px] text-mut flex-1 leading-snug">{c.role}</span>
                  <span className="font-mono text-[11px] text-dim hidden sm:block">{c.expose}</span>
                </div>
              ))}
            </div>
          </Reveal>
          <Reveal delay={100}>
            <div className="panel p-5 h-full flex flex-col gap-4">
              <div>
                <p className="label-mono mb-2">Dimensionnement</p>
                <p className="text-[13px] text-mut leading-relaxed">
                  VPS <span className="text-ink">2 vCPU / 4 Go</span> minimum — le nœud Kafka
                  KRaft single-node pèse environ 1 Go. Pour alléger : Kafka et Redis managés
                  (Upstash), il suffit d'exporter{" "}
                  <code className="font-mono text-[11.5px] text-warn">KAFKA_BROKERS</code> et{" "}
                  <code className="font-mono text-[11.5px] text-warn">REDIS_ADDR</code> et de
                  retirer ces deux conteneurs.
                </p>
              </div>
              <div className="pt-4 border-t border-line">
                <p className="label-mono mb-2">Ce qui est câblé / signalé</p>
                <p className="text-[12.5px] text-mut leading-relaxed">
                  Le socle compile les contrats, les schémas, la pagination explicite, le
                  reaper de paiement et le health-check agrégé. Restent signalés dans le code,
                  jamais tus : le rebranchement <span className="text-ink">Vectorize</span>, la
                  signature des webhooks <span className="text-ink">Stripe/PayDunya</span> avec
                  les clés réelles, l'envoi <span className="text-ink">SMS/email</span> et la
                  synchronisation des montants exacts de{" "}
                  <span className="font-mono text-[11.5px] text-warn">shipping-utils.ts</span>.
                </p>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ---------- 11 · Git & CI ---------- */}
      <section id="git" className="max-w-[1200px] mx-auto px-5 py-16 border-t border-line scroll-mt-16">
        <SectionHead
          num="11"
          kicker="Exécution"
          title="Publier sur Git & déployer en continu"
          lead="Une commande crée et pousse le dépôt ; ensuite chaque push sur main redéploie automatiquement les 7 services sur le VPS via GitHub Actions."
        />

        {/* Pipeline */}
        <Reveal>
          <div className="panel p-5 mb-4 overflow-x-auto">
            <p className="label-mono mb-4">Chaîne de déploiement</p>
            <div className="flex items-stretch gap-2 min-w-[720px]">
              {[
                { t: "Ta machine", s: "scripts/git-publish.sh", tone: "text-ink border-line2" },
                { t: "GitHub", s: "backend-miad", tone: "text-ok border-ok/40" },
                { t: "GitHub Actions", s: "deploy-vps.yml", tone: "text-warn border-warn/40" },
                { t: "SSH", s: "secrets VPS_*", tone: "text-infra border-infra/40" },
                { t: "VPS (k3s)", s: "vps-bootstrap.sh", tone: "text-ok border-ok/40" },
              ].map((p, i, arr) => (
                <div key={p.t} className="flex items-center flex-1">
                  <div className={`flex-1 border rounded-lg px-3 py-3 text-center ${p.tone} bg-bg2/60`}>
                    <p className="font-mono text-[12px] font-bold whitespace-nowrap">{p.t}</p>
                    <p className="font-mono text-[10px] text-dim mt-1 whitespace-nowrap">{p.s}</p>
                  </div>
                  {i < arr.length - 1 && (
                    <svg viewBox="0 0 28 12" className="w-7 h-3 shrink-0 text-dim" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                      <path d="M2 6h20M18 2l5 4-5 4" />
                    </svg>
                  )}
                </div>
              ))}
            </div>
          </div>
        </Reveal>

        <div className="grid lg:grid-cols-[1.2fr_1fr] gap-4">
          <div className="space-y-4">
            <Reveal>
              <div className="panel overflow-hidden">
                <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-line bg-bg2/60">
                  <span className="font-mono text-[11px] text-mut">Étape 1 — pousser vers le dépôt créé</span>
                  <CopyButton text={"git init\ngit add -A\ngit commit -m \"premier commit\"\ngit branch -M main\ngit remote add origin https://github.com/abmcompanysn-dot/backend-miad.git\ngit push -u origin main"} />
                </div>
                <div className="code-block !border-0 !rounded-none p-4">
                  <p><span className="text-ok">$</span> git init</p>
                  <p><span className="text-ok">$</span> git add -A <span className="text-dim"># tout le backend, pas seulement le README</span></p>
                  <p><span className="text-ok">$</span> git commit -m "premier commit"</p>
                  <p><span className="text-ok">$</span> git branch -M main</p>
                  <p><span className="text-ok">$</span> git remote add origin https://github.com/abmcompanysn-dot/backend-miad.git</p>
                  <p><span className="text-ok">$</span> git push -u origin main</p>
                </div>
                <div className="px-4 py-3 border-t border-line bg-bg2/60 flex items-center justify-between gap-3 flex-wrap">
                  <p className="text-[12px] text-dim">
                    Ou en une seule commande : <code className="font-mono text-ok">bash scripts/git-publish.sh</code>
                  </p>
                  <a
                    href="https://github.com/abmcompanysn-dot/backend-miad"
                    target="_blank"
                    rel="noreferrer"
                    className="chip !text-ink hover:!border-ok/50 hover:!text-ok transition-colors"
                  >
                    abmcompanysn-dot/backend-miad
                    <svg viewBox="0 0 12 12" className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4 2h6v6M10 2 2 10" />
                    </svg>
                  </a>
                </div>
              </div>
            </Reveal>
            <Reveal delay={80}>
              <div className="panel p-5">
                <p className="label-mono mb-3 !text-warn">Étape 2 — secrets GitHub (une seule fois)</p>
                <p className="text-[13px] text-mut leading-relaxed mb-3">
                  Sur le dépôt : <span className="font-mono text-[11.5px] text-ink">Settings → Secrets and variables → Actions</span>,
                  ajouter les quatre valeurs que lira le workflow :
                </p>
                <div className="grid sm:grid-cols-2 gap-2">
                  {[
                    ["VPS_HOST", "adresse IP du VPS"],
                    ["VPS_USER", "utilisateur SSH (root…)"],
                    ["VPS_SSH_KEY", "clé privée complète"],
                    ["VPS_PATH", "ex. /opt/miad-backend"],
                  ].map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between gap-2 bg-bg2/70 border border-line rounded-md px-3 py-2">
                      <span className="font-mono text-[11.5px] text-warn">{k}</span>
                      <span className="text-[11px] text-dim text-right">{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            </Reveal>
          </div>
          <Reveal delay={120}>
            <div className="panel p-5 h-full flex flex-col gap-4">
              <div>
                <p className="label-mono mb-2">Ce que fait chaque push</p>
                <p className="text-[13px] text-mut leading-relaxed">
                  Le workflow SSH dans le VPS, tire la branche <span className="font-mono text-[11.5px] text-ok">main</span>,
                  vérifie que le <span className="font-mono text-[11.5px] text-warn">.env</span> est présent,
                  puis relance <span className="font-mono text-[11.5px] text-ink">scripts/vps-bootstrap.sh</span> : rebuild des
                  images, rollout Kubernetes, health-check pod par pod — un déploiement ne passe jamais en silence.
                  <span className="block mt-2 text-warn/90 text-[12px]">
                    Attention : {VPS_ACCESS.host} est une IP Tailscale — le runner GitHub (internet) ne peut pas SSH directement.
                    Pont nécessaire (action Tailscale sur le runner ou IP publique).
                  </span>
                </p>
              </div>
              <div className="pt-4 border-t border-line">
                <p className="label-mono mb-2">Point de vigilance</p>
                <p className="text-[12.5px] text-mut leading-relaxed">
                  Le <span className="font-mono text-[11.5px] text-warn">.env</span> (mots de passe, clés Stripe/PayDunya,
                  JWT_SECRET) n'entre <span className="text-ink">jamais</span> dans le dépôt — il est créé manuellement sur le
                  VPS et listé dans <span className="font-mono text-[11.5px] text-ink">.gitignore</span>. Sans lui, le workflow
                  refuse de déployer.
                </p>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ---------- 12 · Maintenant ---------- */}
      <section id="maintenant" className="max-w-[1200px] mx-auto px-5 py-16 border-t border-line scroll-mt-16">
        <SectionHead
          num="12"
          kicker="Exécution"
          title="Maintenant — Kubernetes sur le VPS"
          lead="Choix acté : Kubernetes (k3s). Voici l'accès au VPS, la feuille de route pas à pas, et pourquoi ce choix tient la route — avec Compose gardé en secours."
        />

        <Reveal>
          <SshPanel />
        </Reveal>

        <Reveal delay={60}>
          <TransferPanel />
        </Reveal>

        <div className="grid lg:grid-cols-[1.25fr_1fr] gap-5 items-start mb-5">
          <Reveal>
            <NowChecklist />
          </Reveal>
          <Reveal delay={120}>
            <div className="panel p-5">
              <div className="flex items-center justify-between gap-3 mb-3">
                <p className="label-mono">Orchestration</p>
                <span className="chip !text-ok !border-ok/40">choix acté</span>
              </div>
              <h3 className="font-display font-bold text-[19px] leading-tight">
                Kubernetes, version k3s.
                <span className="block text-ok mt-1">Sur le VPS, dès maintenant.</span>
              </h3>
              <p className="text-[13.5px] text-mut leading-relaxed mt-3">
                k3s, c'est Kubernetes en un seul binaire : mêmes objets (Deployments, Services,
                probes, LoadBalancer), sans le plan de contrôle à 2 Go de RAM. Les manifests sont
                prêts dans <code className="font-mono text-[11.5px] text-warn">deploy/k8s/</code>{" "}
                (4 fichiers, namespace <span className="font-mono text-[11.5px] text-ink">miad</span>),
                le bootstrap installe tout en une commande — et un jour,{" "}
                <code className="font-mono text-[11.5px] text-warn">kubectl apply</code> des mêmes
                fichiers fonctionnera sur un cluster standard.
              </p>
              <div className="mt-4 pt-4 border-t border-line space-y-3">
                {K8S_PATH.map((p) => (
                  <div key={p.stage} className="flex gap-3">
                    <StatusDot tone={p.tone} />
                    <div>
                      <p className="font-mono text-[12px] text-ink">{p.stage}</p>
                      <p className="text-[12px] text-mut leading-relaxed mt-0.5">{p.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </Reveal>
        </div>

        <Reveal>
          <div className="panel overflow-hidden">
            <div className="px-4 py-3 border-b border-line bg-bg2/60 flex items-center justify-between gap-3 flex-wrap">
              <span className="label-mono !text-ink">Compose vs Kubernetes — 7 critères</span>
              <span className="chip">pour 1 VPS · 7 services · trafic actuel</span>
            </div>
            <div className="hidden md:grid md:grid-cols-[1.1fr_1fr_1fr_90px] px-4 py-2 border-b border-line font-mono text-[10.5px] uppercase tracking-widest text-dim">
              <span>Critère</span>
              <span>Docker Compose</span>
              <span>Kubernetes</span>
              <span className="text-right">Avantage</span>
            </div>
            {K8S_COMPARE.map((r, i) => (
              <div
                key={r.criterion}
                className={`row-hover grid grid-cols-1 md:grid-cols-[1.1fr_1fr_1fr_90px] gap-1.5 md:gap-3 px-4 py-3 ${
                  i > 0 ? "border-t border-line" : ""
                }`}
              >
                <span className="text-[13px] text-ink font-medium">{r.criterion}</span>
                <span className={`text-[12.5px] ${r.winner === "compose" ? "text-ok" : "text-mut"}`}>{r.compose}</span>
                <span className={`text-[12.5px] ${r.winner === "k8s" ? "text-ok" : "text-mut"}`}>{r.k8s}</span>
                <span className="md:text-right">
                  <span
                    className={`font-mono text-[10.5px] px-2 py-0.5 rounded-full border ${
                      r.winner === "compose"
                        ? "text-ok border-ok/40 bg-ok/10"
                        : r.winner === "k8s"
                          ? "text-infra border-infra/40 bg-infra/10"
                          : "text-dim border-line2"
                    }`}
                  >
                    {r.winner === "compose" ? "compose" : r.winner === "k8s" ? "k8s" : "égalité"}
                  </span>
                </span>
              </div>
            ))}
            <div className="px-4 py-3.5 border-t border-line bg-bg2/60">
              <p className="font-mono text-[11.5px] text-mut leading-relaxed">
                <span className="text-infra">Bilan :</span> sur ce tableau, Compose gagne 4 critères —
                mais Kubernetes a été <span className="text-ink">choisi quand même</span>, et c'est
                défendable : en prenant <span className="text-ok">k3s</span>, l'écart de complexité
                devient minime (un binaire, zéro plan de contrôle à opérer) et tu gardes les vraies
                forces de K8s : rolling updates, probes, scaling. Compose reste disponible en repli
                avec exactement le même .env.
              </p>
            </div>
          </div>
        </Reveal>
      </section>

      {/* ---------- 13 · Admin ---------- */}
      <section id="admin" className="max-w-[1200px] mx-auto px-5 py-16 border-t border-line scroll-mt-16">
        <SectionHead
          num="13"
          kicker="Conception"
          title="Console d'administration"
          lead="Un 8ᵉ service (admin-svc) embarque l'interface complète — servie par le backend lui-même sur /admin, zéro build frontend. Chaque requête API exige un JWT role=admin, vérifié deux fois (admin-svc puis le service propriétaire)."
        />

        <div className="grid lg:grid-cols-[1.45fr_1fr] gap-4 mb-4">
          {/* Aperçu vivant du tableau de bord */}
          <Reveal>
            <div className="panel overflow-hidden">
              <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-line bg-bg2/60">
                <span className="w-2.5 h-2.5 rounded-full bg-alert/70" />
                <span className="w-2.5 h-2.5 rounded-full bg-warn/70" />
                <span className="w-2.5 h-2.5 rounded-full bg-ok/70" />
                <span className="font-mono text-[10.5px] text-mut ml-2">https://miadmarket.com/admin</span>
                <span className="chip ml-auto !text-[10px] !text-ok !border-ok/40">GET /admin</span>
              </div>
              <div className="grid grid-cols-[92px_1fr] min-h-[300px]">
                <div className="border-r border-line bg-bg2/40 p-2.5 flex flex-col gap-1.5">
                  {["Vue d'ensemble", "Commandes", "Produits", "Boutiques", "Clients", "Paiements", "Livraison", "Système"].map((v, i) => (
                    <span
                      key={v}
                      className={`block font-mono text-[9.5px] px-2 py-1.5 rounded-md transition-colors cursor-default ${
                        i === 0 ? "bg-ok/12 text-ok border border-ok/30" : "text-dim hover:text-ink hover:bg-raise border border-transparent"
                      }`}
                    >
                      {v}
                    </span>
                  ))}
                </div>
                <div className="p-4">
                  <div className="grid grid-cols-4 gap-2 mb-4">
                    {[
                      { l: "Produits", v: "1 284" },
                      { l: "Boutiques", v: "73" },
                      { l: "Commandes", v: "9 412" },
                      { l: "CA confirmé", v: "8,4 M XOF" },
                    ].map((t, i) => (
                      <div key={t.l} className="bg-bg2/70 border border-line rounded-lg p-2.5">
                        <p className="font-display font-extrabold text-[15px] leading-none">{t.v}</p>
                        <p className="font-mono text-[8.5px] text-dim uppercase tracking-wider mt-1.5">{t.l}</p>
                        <div className="h-[3px] rounded-full bg-line mt-2 overflow-hidden">
                          <div className="h-full bg-ok bar-grow" style={{ width: `${48 + i * 14}%`, animationDelay: `${i * 130}ms` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="space-y-1.5">
                    {[
                      { ref: "MIAD-20260214-113207-1", st: "paid", tone: "ok", amt: "24 500" },
                      { ref: "MIAD-20260214-113241-1", st: "pending_payment", tone: "warn", amt: "9 000" },
                      { ref: "MIAD-20260214-113312-2", st: "shipped", tone: "infra", amt: "61 250" },
                    ].map((o, i) => (
                      <div key={o.ref} className="flex items-center gap-3 bg-bg2/50 border border-line rounded-md px-3 py-2">
                        <span className={`w-1.5 h-1.5 rounded-full ${i === 1 ? "bg-warn node-pulse" : "bg-ok/70"}`} />
                        <span className="font-mono text-[10px] text-ink/80 flex-1 truncate">{o.ref}</span>
                        <span className={`font-mono text-[9px] px-2 py-0.5 rounded-full border ${
                          o.tone === "ok" ? "text-ok border-ok/40 bg-ok/8" : o.tone === "warn" ? "text-warn border-warn/40 bg-warn/8" : "text-infra border-infra/40 bg-infra/8"
                        }`}>{o.st}</span>
                        <span className="font-mono text-[10px] text-mut">{o.amt} XOF</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="px-4 py-3 border-t border-line bg-bg2/60 flex items-center gap-3 flex-wrap">
                <span className="label-mono">Embarquée dans admin-svc (embed Go)</span>
                <span className="chip !text-[10px]">vanilla JS · zéro dépendance</span>
                <span className="chip !text-[10px]">JWT role=admin exigé</span>
              </div>
            </div>
          </Reveal>

          {/* Auth + câblages réels */}
          <div className="space-y-4">
            <Reveal delay={80}>
              <div className="panel p-5">
                <p className="label-mono mb-3.5 !text-warn">Trois façons de s'authentifier</p>
                <div className="space-y-3">
                  {AUTH_FLOWS.map((f) => (
                    <div key={f.name} className={`border rounded-lg p-3.5 bg-bg2/60 ${
                      f.tone === "ok" ? "border-ok/30" : f.tone === "warn" ? "border-warn/30" : "border-infra/30"
                    }`}>
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <p className="font-display font-bold text-[13.5px]">{f.name}</p>
                        <span className={`chip !text-[9.5px] ${
                          f.tone === "ok" ? "!text-ok !border-ok/40" : f.tone === "warn" ? "!text-warn !border-warn/40" : "!text-infra !border-infra/40"
                        }`}>auth-svc</span>
                      </div>
                      <p className={`font-mono text-[10.5px] mt-1.5 ${
                        f.tone === "ok" ? "text-ok/80" : f.tone === "warn" ? "text-warn/80" : "text-infra/80"
                      }`}>{f.endpoint}</p>
                      <p className="text-[12px] text-mut leading-relaxed mt-2">{f.desc}</p>
                    </div>
                  ))}
                </div>
              </div>
            </Reveal>
            <Reveal delay={160}>
              <div className="panel p-5">
                <p className="label-mono mb-3 !text-ok">Paiements — câblés pour de vrai</p>
                <ul className="space-y-2.5">
                  {[
                    ["Stripe Checkout Session", "api.stripe.com/v1/checkout/sessions — URL de paiement carte renvoyée au frontend"],
                    ["PayDunya invoices", "app.paydunya.com/api/v1 — Wave & Orange Money en XOF, redirect_url fournie"],
                    ["Signatures vérifiées", "Stripe-Signature (HMAC) + token PayDunya contrôlés avant toute mutation"],
                    ["Kafka de bout en bout", "order.created → init paiement → payment.confirmed → commande paid"],
                  ].map(([k, v]) => (
                    <li key={k} className="flex gap-3 text-[12.5px] leading-relaxed">
                      <span className="text-ok shrink-0 mt-[3px]">▸</span>
                      <span><span className="text-ink">{k}</span> <span className="text-mut">— {v}</span></span>
                    </li>
                  ))}
                </ul>
              </div>
            </Reveal>
          </div>
        </div>

        {/* Les 8 vues */}
        <Reveal>
          <div className="panel overflow-hidden">
            <div className="px-4 py-3 border-b border-line bg-bg2/60 flex items-center justify-between gap-3 flex-wrap">
              <span className="label-mono !text-ink">Les 8 vues de la console</span>
              <span className="chip !text-[10px]">chaque vue interroge son service propriétaire via l'API admin</span>
            </div>
            <div className="grid md:grid-cols-2 divide-y md:divide-y-0 divide-line">
              {ADMIN_VIEWS.map((v, i) => (
                <div key={v.name} className={`row-hover px-4 py-3.5 flex gap-4 ${i > 0 ? "md:border-t md:border-line" : ""} ${i % 2 === 1 ? "md:border-l md:border-line" : ""}`}>
                  <span className="font-mono text-[11px] text-ok pt-0.5 shrink-0">{String(i + 1).padStart(2, "0")}</span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2.5 flex-wrap">
                      <p className="font-display font-bold text-[14px]">{v.name}</p>
                      <span className="chip !text-[9.5px]">{v.svc}</span>
                    </div>
                    <p className="text-[12.5px] text-mut leading-relaxed mt-1">{v.desc}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="px-4 py-3.5 border-t border-line bg-bg2/60">
              <p className="font-mono text-[11.5px] text-mut leading-relaxed">
                <span className="text-ok">Première connexion :</span> le compte admin est seedé au démarrage depuis{" "}
                <span className="text-warn">ADMIN_EMAIL</span> / <span className="text-warn">ADMIN_PASSWORD</span> du .env —
                à définir <span className="text-ink">avant le premier boot</span> sur le VPS.
              </p>
            </div>
          </div>
        </Reveal>
      </section>

      {/* ---------- Pied ---------- */}
      <footer className="border-t border-line bg-bg2/50">
        <div className="max-w-[1200px] mx-auto px-5 py-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <p className="font-display font-bold text-[14px]">MIAD MARKET — backend sans WordPress</p>
            <p className="font-mono text-[11px] text-dim mt-1">
              document de travail · à mettre à jour si le périmètre WooCommerce/Dokan évolue avant la migration
            </p>
          </div>
          <div className="flex items-center gap-2">
            <StatusDot tone="ok" />
            <span className="font-mono text-[11px] text-mut">
              8 services · console admin /admin · Firebase + OTP · k3s acté · phase 01/06
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
