/**
 * Clara's mark for icons: a safety-orange first-aid cross on charcoal, square corners (Field Kit). Drawn with
 * Next's ImageResponse (Satori), so it needs only flexbox divs. `pad` shrinks the cross for maskable icons, whose
 * outer 20% may be cropped.
 */
export function ClaraMark({ size, pad = 0.18 }: { size: number; pad?: number }) {
  const inner = size * (1 - pad * 2);
  const bar = inner * 0.3;
  return (
    <div style={{ width: size, height: size, background: "#18181B", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: inner, height: inner, position: "relative", display: "flex" }}>
        <div style={{ position: "absolute", left: (inner - bar) / 2, top: 0, width: bar, height: inner, background: "#F97316" }} />
        <div style={{ position: "absolute", top: (inner - bar) / 2, left: 0, height: bar, width: inner, background: "#F97316" }} />
      </div>
    </div>
  );
}
