import Link from "next/link";
import { PULSE_PATH } from "../lib/mark";

const LINKS = [
  { href: "/app", label: "Companion app" },
  { href: "/maintainer", label: "Network" },
  { href: "/dashboard", label: "Dispatch" },
  { href: "/map", label: "Kit map" },
] as const;

/** Clara's mark: a pulse line on a red rounded square. Never a cross or plus (protected emblem). */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <span className="brand-mark" aria-hidden="true" style={{ width: size, height: size }}>
      <svg width={size * 0.76} height={size * 0.76} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
        <path d={PULSE_PATH} />
      </svg>
    </span>
  );
}

/** The bar on every page. `current` marks the page you're on; `title` adds a section name after "Clara" (e.g. "Clara Dispatch"). */
export function TopBar({ current, title = "Clara", children }: { current?: string; title?: string; children?: React.ReactNode }) {
  const sub = title.startsWith("Clara ") ? title.slice("Clara ".length) : null;
  return (
    <header className="topbar">
      <Link href="/" className="brand">
        <BrandMark />
        <span>
          Clara{sub ? <span className="brand-sub"> {sub}</span> : null}
        </span>
      </Link>
      {children}
      <span className="spacer" />
      <nav aria-label="Pages">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} aria-current={current === l.href ? "page" : undefined}>
            {l.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}

export function StatusPill({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span className="pill" data-tone={tone}>
      {children}
    </span>
  );
}

/** A stat tile: label over a big number. */
export function Tile({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="tile">
      <span className="lbl">{label}</span>
      <span className={`big${tone ? ` t-${tone}` : ""}`}>{value}</span>
    </div>
  );
}
