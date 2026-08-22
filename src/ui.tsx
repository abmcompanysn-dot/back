import { useEffect, useRef, useState, type ReactNode } from "react";

/* ---------- Révélation au scroll ---------- */

export function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setInView(true);
          obs.disconnect();
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`reveal ${inView ? "reveal-in" : ""} ${className}`}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </div>
  );
}

/* ---------- Compteur animé ---------- */

export function Counter({
  value,
  suffix = "",
  className = "",
}: {
  value: number;
  suffix?: string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [n, setN] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting) return;
        obs.disconnect();
        const t0 = performance.now();
        const dur = 1100;
        const tick = (t: number) => {
          const p = Math.min(1, (t - t0) / dur);
          setN(Math.round(value * (1 - Math.pow(1 - p, 3))));
          if (p < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      },
      { threshold: 0.4 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [value]);

  return (
    <span ref={ref} className={className}>
      {n}
      {suffix}
    </span>
  );
}

/* ---------- Bouton copier ---------- */

export function CopyButton({ text, label = "Copier" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <button
      onClick={copy}
      className={`chip cursor-pointer transition-colors ${
        copied
          ? "!border-ok/60 !text-ok"
          : "hover:!border-line2 hover:!text-ink"
      }`}
    >
      {copied ? (
        <>
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
            <path d="M2 6.5 4.5 9 10 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Copié
        </>
      ) : (
        <>
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
            <rect x="4" y="4" width="6.5" height="6.5" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
            <path d="M8 4V2.8A1.3 1.3 0 0 0 6.7 1.5H2.8A1.3 1.3 0 0 0 1.5 2.8v3.9A1.3 1.3 0 0 0 2.8 8H4" stroke="currentColor" strokeWidth="1.3" />
          </svg>
          {label}
        </>
      )}
    </button>
  );
}

/* ---------- Tête de section ---------- */

export function SectionHead({
  num,
  kicker,
  title,
  lead,
}: {
  num: string;
  kicker: string;
  title: string;
  lead?: string;
}) {
  return (
    <Reveal className="mb-9">
      <div className="flex items-center gap-4 mb-4">
        <span className="font-mono text-[13px] text-ok/90 tracking-widest">{num}</span>
        <span className="h-px flex-1 bg-gradient-to-r from-line2 to-transparent" />
        <span className="label-mono">{kicker}</span>
      </div>
      <h2 className="h-display text-[clamp(1.7rem,4vw,2.6rem)] uppercase">{title}</h2>
      {lead && <p className="mt-4 max-w-2xl text-mut text-[15px] leading-relaxed">{lead}</p>}
    </Reveal>
  );
}

/* ---------- Pastille d'état ---------- */

export function StatusDot({ tone = "ok" }: { tone?: "ok" | "warn" | "alert" | "infra" }) {
  const c =
    tone === "ok"
      ? "bg-ok dot-live"
      : tone === "warn"
        ? "bg-warn"
        : tone === "alert"
          ? "bg-alert"
          : "bg-infra";
  return <span className={`inline-block w-2 h-2 rounded-full ${c}`} />;
}

/* ---------- Chip de méthode HTTP ---------- */

export function MethodChip({ method }: { method: string }) {
  const cls =
    method === "GET"
      ? "text-ok border-ok/40 bg-ok/10"
      : method === "POST"
        ? "text-warn border-warn/40 bg-warn/10"
        : "text-infra border-infra/40 bg-infra/10";
  return (
    <span className={`inline-block w-12 text-center font-mono text-[10.5px] font-medium px-1.5 py-0.5 rounded border ${cls}`}>
      {method}
    </span>
  );
}

/* ---------- Bloc de commande terminal ---------- */

export function CmdBlock({ n, cmd, note }: { n: number; cmd: string; note: string }) {
  return (
    <div className="panel panel-hover p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <span className="font-mono text-[12px] text-dim shrink-0">
            {String(n).padStart(2, "0")}
          </span>
          <code className="font-mono text-[13px] text-ink truncate">{cmd}</code>
        </div>
        <CopyButton text={cmd} label="" />
      </div>
      <p className="text-[12.5px] text-mut leading-relaxed">{note}</p>
    </div>
  );
}

/* ---------- Petit glyphe SVG tracé main ---------- */

export function Glyph({ name, className = "text-ok" }: { name: string; className?: string }) {
  const paths: Record<string, ReactNode> = {
    store: (
      <>
        <path d="M2.5 5.5 4 2.5h8l1.5 3v1h-11z" />
        <path d="M3.5 6.5v6h9v-6M6.5 12.5V9h3v3.5" />
      </>
    ),
    globe: (
      <>
        <circle cx="8" cy="8" r="5.5" />
        <path d="M2.5 8h11M8 2.5c-3.5 3.5-3.5 7.5 0 11M8 2.5c3.5 3.5 3.5 7.5 0 11" />
      </>
    ),
    layers: (
      <>
        <path d="m8 2 5.5 3L8 8 2.5 5z" />
        <path d="m2.5 8 5.5 3 5.5-3M2.5 11l5.5 3 5.5-3" />
      </>
    ),
    truck: (
      <>
        <path d="M1.5 4h8v6h-8zM9.5 6H12l2 2.2V10h-4.5" />
        <circle cx="4.5" cy="11.5" r="1.4" />
        <circle cx="11.5" cy="11.5" r="1.4" />
      </>
    ),
    card: (
      <>
        <rect x="1.5" y="3.5" width="13" height="9" rx="1.5" />
        <path d="M1.5 6.5h13M4 10h3" />
      </>
    ),
    search: (
      <>
        <circle cx="6.5" cy="6.5" r="4" />
        <path d="m9.5 9.5 4 4" />
      </>
    ),
    board: (
      <>
        <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
        <path d="M5 10V7M8 10V5M11 10V8" />
      </>
    ),
    shield: (
      <>
        <path d="M8 1.8 13.5 4v4c0 3.4-2.3 5.6-5.5 6.8C4.8 13.6 2.5 11.4 2.5 8V4z" />
        <path d="m5.5 7.8 1.8 1.8 3.4-3.6" />
      </>
    ),
    bell: (
      <>
        <path d="M8 2.5c-2.6 0-4 2-4 4.5v3l-1.5 2h11L12 10V7c0-2.5-1.4-4.5-4-4.5z" />
        <path d="M6.5 13.5a1.6 1.6 0 0 0 3 0" />
      </>
    ),
  };
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`w-5 h-5 shrink-0 ${className}`}
      aria-hidden
    >
      {paths[name] ?? paths.board}
    </svg>
  );
}
