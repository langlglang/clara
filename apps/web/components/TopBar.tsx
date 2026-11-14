import Link from "next/link";

const LINKS = [
  { href: "/app", label: "Companion app" },
  { href: "/maintainer", label: "Network" },
  { href: "/dashboard", label: "Dispatch" },
  { href: "/map", label: "Kit map" },
] as const;

/** The bar on every page. `current` marks the page you're on; `title` replaces "Clara" (e.g. "Clara Dispatch"). */
export function TopBar({ current, title = "Clara", children }: { current?: string; title?: string; children?: React.ReactNode }) {
  return (
    <header className="topbar">
      <Link href="/" className="brand">
        {title}
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

/** A stat tile: label over a big mono number. */
export function Tile({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="tile">
      <span className="lbl">{label}</span>
      <span className={`big${tone ? ` t-${tone}` : ""}`}>{value}</span>
    </div>
  );
}
