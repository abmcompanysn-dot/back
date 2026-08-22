import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { Tone } from "./data";

/* ---------------- in-view hook ---------------- */
export function useInView<T extends HTMLElement>(threshold = 0.2) {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setInView(true);
          io.disconnect();
        }
      },
      { threshold }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);

  return { ref, inView };
}

/* ---------------- reveal ---------------- */
export function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const { ref, inView } = useInView<HTMLDivElement>(0.12);
  return (
    <div
      ref={ref}
      className={`reveal ${inView ? "is-in" : ""} ${className}`}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </div>
  );
}

/* ---------------- animated counter ---------------- */
export function Counter({
  to,
  suffix = "",
  className = "",
}: {
  to: number;
  suffix?: string;
  className?: string;
}) {
  const { ref, inView } = useInView<HTMLSpanElement>(0.4);
  const [val, setVal] = useState(0);

  useEffect(() => {
    if (!inView) return;
    if (to === 0) {
      setVal(0);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const dur = 1100;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setVal(Math.round(to * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inView, to]);

  return (
    <span ref={ref} className={className}>
      {val}
      {suffix}
    </span>
  );
}

/* ---------------- gauge ---------------- */
const TONE_STROKE: Record<Tone, string> = {
  ok: "#6fcf8e",
  warn: "#f2a93b",
  alert: "#f2695c",
  info: "#7fb1e8",
  neutral: "#8b98b8",
};

export function Gauge({
  value,
  size = 190,
  label,
  caption,
}: {
  value: number;
  size?: number;
  label: string;
  caption: string;
}) {
  const { ref, inView } = useInView<HTMLDivElement>(0.35);
  const stroke = 11;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = inView ? c * (1 - value / 100) : c;
  const color = value >= 75 ? TONE_STROKE.ok : value >= 45 ? TONE_STROKE.warn : TONE_STROKE.alert;

  return (
    <div ref={ref} className="relative inline-flex flex-col items-center">
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="#223050"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          className="gauge-ring"
          style={{ filter: `drop-shadow(0 0 8px ${color}55)` }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-display text-5xl font-bold leading-none text-paper">
          <Counter to={value} />
        </span>
        <span className="font-mono text-[11px] tracking-[0.22em] text-mist uppercase mt-1.5">
          / 100
        </span>
      </div>
      <p className="mt-4 font-display text-sm font-semibold tracking-wide text-paper uppercase">
        {label}
      </p>
      <p className="mt-1 max-w-[240px] text-center text-[13px] leading-snug text-mist">
        {caption}
      </p>
    </div>
  );
}

/* ---------------- score bar ---------------- */
export function ScoreBar({
  label,
  value,
  note,
  tone,
  delay = 0,
}: {
  label: string;
  value: number;
  note: string;
  tone: Tone;
  delay?: number;
}) {
  const { ref, inView } = useInView<HTMLDivElement>(0.3);
  return (
    <div ref={ref} className="group">
      <div className="flex items-baseline justify-between gap-4">
        <p className="font-display text-[15px] font-semibold text-paper">{label}</p>
        <p className="font-mono text-sm text-mist tabular-nums">
          <Counter to={value} />
          <span className="text-dim">/100</span>
        </p>
      </div>
      <div className="mt-2 h-[7px] w-full overflow-hidden rounded-full bg-ink2 ring-1 ring-line">
        <div
          className="score-bar h-full rounded-full"
          style={{
            width: inView ? `${value}%` : "0%",
            background: TONE_STROKE[tone],
            transitionDelay: `${delay}ms`,
            boxShadow: `0 0 10px ${TONE_STROKE[tone]}66`,
          }}
        />
      </div>
      <p className="mt-1.5 text-[13px] leading-snug text-mist">{note}</p>
    </div>
  );
}

/* ---------------- badge ---------------- */
const BADGE_TONES: Record<Tone, string> = {
  ok: "text-moss border-moss/40 bg-moss/10",
  warn: "text-amber border-amber/40 bg-amber/10",
  alert: "text-coral border-coral/40 bg-coral/10",
  info: "text-sky border-sky/40 bg-sky/10",
  neutral: "text-mist border-line2 bg-panel2",
};

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 border px-2 py-[3px] font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] ${BADGE_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

/* ---------------- section heading ---------------- */
export function SectionHead({
  num,
  kicker,
  title,
  intro,
}: {
  num: string;
  kicker: string;
  title: string;
  intro?: string;
}) {
  return (
    <Reveal className="mb-10">
      <div className="flex items-center gap-4">
        <span className="font-display text-sm font-bold text-amber tabular-nums tracking-widest">
          {num}
        </span>
        <span className="h-px flex-1 max-w-24 bg-line2" />
        <span className="font-mono text-[11px] uppercase tracking-[0.28em] text-dim">
          {kicker}
        </span>
      </div>
      <h2 className="mt-4 font-display text-3xl font-bold tracking-tight text-paper sm:text-4xl">
        {title}
      </h2>
      {intro && <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-mist">{intro}</p>}
    </Reveal>
  );
}

/* ---------------- terminal typewriter ---------------- */
const TERM_COLORS: Record<Tone, string> = {
  ok: "text-moss",
  warn: "text-amber",
  alert: "text-coral",
  info: "text-sky",
  neutral: "text-paper",
};

export function Terminal({
  lines,
}: {
  lines: { text: string; tone: Tone }[];
}) {
  const { ref, inView } = useInView<HTMLDivElement>(0.25);
  const [lineIdx, setLineIdx] = useState(0);
  const [charIdx, setCharIdx] = useState(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!inView || done) return;
    const current = lines[lineIdx];
    if (!current) return;
    if (charIdx < current.text.length) {
      const t = setTimeout(
        () => setCharIdx((c) => c + 2),
        current.text.startsWith("$") ? 26 : 9
      );
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => {
      if (lineIdx + 1 < lines.length) {
        setLineIdx((l) => l + 1);
        setCharIdx(0);
      } else {
        setDone(true);
      }
    }, 240);
    return () => clearTimeout(t);
  }, [inView, lineIdx, charIdx, done, lines]);

  return (
    <div ref={ref} className="clip-corner border border-line bg-[#0a0f19] shadow-[0_18px_50px_-20px_rgba(0,0,0,0.8)]">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-coral/80" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber/80" />
        <span className="h-2.5 w-2.5 rounded-full bg-moss/80" />
        <span className="ml-3 font-mono text-[11px] uppercase tracking-[0.2em] text-dim">
          audit — lecture seule
        </span>
        <span className="ml-auto flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-coral">
          <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-coral" />
          rec
        </span>
      </div>
      <div className="min-h-[300px] px-4 py-4 sm:px-6 font-mono text-[12.5px] leading-[1.9] sm:text-[13px]">
        {lines.slice(0, lineIdx).map((l, i) => (
          <p key={i} className={TERM_COLORS[l.tone]}>
            {l.text}
          </p>
        ))}
        {lineIdx < lines.length && (
          <p className={TERM_COLORS[lines[lineIdx].tone]}>
            {lines[lineIdx].text.slice(0, charIdx)}
            <span className="cursor-blink text-teal">▌</span>
          </p>
        )}
        {done && (
          <p className="text-dim">
            $ <span className="cursor-blink text-teal">▌</span>
          </p>
        )}
      </div>
    </div>
  );
}

/* ---------------- inline icons ---------------- */
type IconProps = { className?: string; style?: CSSProperties };
const S = (props: IconProps & { children: ReactNode }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={props.className ?? "h-4 w-4"}
    aria-hidden="true"
  >
    {props.children}
  </svg>
);

export const Ic = {
  folder: (p: IconProps) => (
    <S {...p}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </S>
  ),
  file: (p: IconProps) => (
    <S {...p}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
    </S>
  ),
  code: (p: IconProps) => (
    <S {...p}>
      <path d="m8 9-3 3 3 3" />
      <path d="m16 9 3 3-3 3" />
      <path d="m13 6-2 12" />
    </S>
  ),
  check: (p: IconProps) => (
    <S {...p}>
      <path d="m4.5 12.5 5 5 10-11" />
    </S>
  ),
  warn: (p: IconProps) => (
    <S {...p}>
      <path d="M12 3 2.5 20h19Z" />
      <path d="M12 9.5v5" />
      <path d="M12 17.6v.1" />
    </S>
  ),
  lock: (p: IconProps) => (
    <S {...p}>
      <rect x="5" y="11" width="14" height="9" rx="1.5" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </S>
  ),
  box: (p: IconProps) => (
    <S {...p}>
      <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9Z" />
      <path d="m4 7.5 8 4.5 8-4.5" />
      <path d="M12 12v9" />
    </S>
  ),
  chip: (p: IconProps) => (
    <S {...p}>
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
      <path d="M10 2.5V5m4-2.5V5M10 19v2.5M14 19v2.5M2.5 10H5m-2.5 4H5M19 10h2.5M19 14h2.5" />
    </S>
  ),
  term: (p: IconProps) => (
    <S {...p}>
      <rect x="3" y="4.5" width="18" height="15" rx="1.5" />
      <path d="m7 9.5 3 2.75L7 15" />
      <path d="M12.5 15H17" />
    </S>
  ),
  flag: (p: IconProps) => (
    <S {...p}>
      <path d="M5 21V4" />
      <path d="M5 4c4-2.2 7 2.2 12 0v9c-5 2.2-8-2.2-12 0" />
    </S>
  ),
  scale: (p: IconProps) => (
    <S {...p}>
      <path d="M12 4v16m-5 0h10" />
      <path d="M4 8h16" />
      <path d="m6 8-2.5 5a3 3 0 0 0 5 0Z" />
      <path d="m18 8-2.5 5a3 3 0 0 0 5 0Z" />
    </S>
  ),
  arrow: (p: IconProps) => (
    <S {...p}>
      <path d="M4 12h15" />
      <path d="m13 6 6 6-6 6" />
    </S>
  ),
  eye: (p: IconProps) => (
    <S {...p}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </S>
  ),
  doc: (p: IconProps) => (
    <S {...p}>
      <path d="M6 3h9l4 4v14H6Z" />
      <path d="M15 3v4h4" />
      <path d="M9 12h7M9 15.5h7" />
    </S>
  ),
};
