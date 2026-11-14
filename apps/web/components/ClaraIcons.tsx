/** Line icons for the landing page and sign-up. All decorative: the text next to each icon carries the meaning. */

type IconProps = { size?: number; className?: string };

const line = (size: number, className?: string) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  focusable: false,
  className,
});

/** The Clara mark: an orange rounded square with a black cross. */
export function ClaraMark({ size = 26 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" aria-hidden="true" focusable="false">
      <rect width="26" height="26" rx="5" fill="var(--accent)" />
      <path d="M13 6.5v13M6.5 13h13" stroke="var(--on-accent)" strokeWidth="3.4" strokeLinecap="square" />
    </svg>
  );
}

export function IconPerson({ size = 24, className }: IconProps) {
  return (
    <svg {...line(size, className)}>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

export function IconPersonAdd({ size = 24, className }: IconProps) {
  return (
    <svg {...line(size, className)}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M19 8v6M22 11h-6" />
    </svg>
  );
}

export function IconCar({ size = 24, className }: IconProps) {
  return (
    <svg {...line(size, className)}>
      <path d="M5 17h14M6 17v2M18 17v2M4 13l2-6h12l2 6v4H4z" />
    </svg>
  );
}

export function IconPin({ size = 24, className }: IconProps) {
  return (
    <svg {...line(size, className)}>
      <path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

export function IconBell({ size = 24, className }: IconProps) {
  return (
    <svg {...line(size, className)}>
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  );
}

export function IconPhone({ size = 24, className }: IconProps) {
  return (
    <svg {...line(size, className)}>
      <rect x="6" y="2" width="12" height="20" rx="2.5" />
      <path d="M11 18h2" />
    </svg>
  );
}

export function IconKit({ size = 24, className }: IconProps) {
  return (
    <svg {...line(size, className)}>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M12 11v5M9.5 13.5h5" />
    </svg>
  );
}

export function IconChevronLeft({ size = 20, className }: IconProps) {
  return (
    <svg {...line(size, className)} strokeWidth={2.2}>
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

export function IconCheck({ size = 16, className }: IconProps) {
  return (
    <svg {...line(size, className)} strokeWidth={3.2}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

/** Large tile glyph: a first-aid cross in a rounded square. */
export function GlyphFirstAid({ size = 56 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 56 56" aria-hidden="true" focusable="false">
      <rect x="2" y="2" width="52" height="52" rx="12" fill="none" stroke="currentColor" strokeWidth="3" />
      <path d="M28 15v26M15 28h26" stroke="currentColor" strokeWidth="6" strokeLinecap="square" />
    </svg>
  );
}

/** Large tile glyph: a car seen from the side. */
export function GlyphCar({ size = 56 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 56 56" fill="none" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M8 36V27l5-12h30l5 12v9z" />
      <path d="M8 27h40" />
      <circle cx="17" cy="38" r="5" fill="currentColor" stroke="none" />
      <circle cx="39" cy="38" r="5" fill="currentColor" stroke="none" />
    </svg>
  );
}
