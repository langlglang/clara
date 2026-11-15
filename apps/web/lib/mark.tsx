/**
 * Clara's mark for icons: a white pulse line on Clara red (Warm theme). Deliberately not a cross or plus, which
 * reads as the protected Red Cross emblem. Drawn with Next's ImageResponse (Satori): full-bleed red so the OS can
 * round the corners, and `pad` shrinks the line for maskable icons, whose outer 20% may be cropped.
 */
/** The pulse line, shared by the icons and the header mark so they always match. */
export const PULSE_PATH = "M2 12h4.5l2.5-6 5 12 2.5-6H22";

export function ClaraMark({ size, pad = 0.18 }: { size: number; pad?: number }) {
  const inner = size * (1 - pad * 2);
  return (
    <div style={{ width: size, height: size, background: "#D42A2F", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <svg width={inner} height={inner} viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
        <path d={PULSE_PATH} />
      </svg>
    </div>
  );
}
