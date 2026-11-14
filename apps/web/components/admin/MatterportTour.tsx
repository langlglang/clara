"use client";

import { useEffect, useRef, useState } from "react";
import type { KitPlacement } from "@clara/placement";

const SDK_URL = "https://static.matterport.com/showcase-sdk/latest.js";

type Sdk = { Tag?: { add(...t: unknown[]): Promise<string[]> }; Mattertag?: { add(t: unknown[]): Promise<string[]> } };
declare global {
  interface Window {
    MP_SDK?: { connect(frame: HTMLIFrameElement, key: string, version?: string): Promise<Sdk> };
  }
}

function loadSdk(): Promise<void> {
  if (window.MP_SDK) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SDK_URL;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("couldn't load the Showcase SDK"));
    document.head.appendChild(s);
  });
}

/**
 * The floor's Matterport Showcase tour. With the SDK key (browser-safe by design) it connects the Showcase SDK and
 * adds a "Clara kit" tag at each planned kit (Model API positions are z-up; Showcase is y-up). Without it, a plain embed.
 */
export function MatterportTour({ modelId, sdkKey, kits }: { modelId: string; sdkKey: string | null; kits: KitPlacement[] }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [note, setNote] = useState<string>("");
  const src = `https://my.matterport.com/show/?m=${encodeURIComponent(modelId)}&play=1&qs=1&brand=0${sdkKey ? `&applicationKey=${encodeURIComponent(sdkKey)}` : ""}`;
  const kitKey = kits.map((k) => k.id).join(",");

  useEffect(() => {
    setNote(sdkKey ? "Connecting the Showcase SDK…" : "Plain embed (no MP_SDK_KEY): kit tags need the SDK.");
    if (!sdkKey || !frame.current) return;
    let cancelled = false;
    const el = frame.current;
    const go = async () => {
      try {
        await loadSdk();
        const sdk = await Promise.race([
          window.MP_SDK!.connect(el, sdkKey, ""),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no answer from the tour in 25 s")), 25_000)),
        ]);
        if (cancelled) return;
        const tags = kits
          .filter((k) => k.position)
          .map((k) => ({
            label: "Clara kit",
            description: k.directions,
            anchorPosition: { x: k.position!.x, y: k.position!.z - 0.4, z: -k.position!.y },
            stemVector: { x: 0, y: 0.5, z: 0 },
            color: { r: 0.976, g: 0.451, b: 0.086 },
          }));
        if (tags.length === 0) return setNote("Connected. Plan kits to see them tagged in 3D.");
        if (sdk.Tag) await sdk.Tag.add(...tags);
        else if (sdk.Mattertag) await sdk.Mattertag.add(tags);
        if (!cancelled) setNote(`Connected. ${tags.length} Clara kit tag${tags.length === 1 ? "" : "s"} placed.`);
      } catch (e) {
        if (!cancelled) setNote(`3D tags unavailable (${(e as Error).message ?? "SDK error"}); the tour still works.`);
      }
    };
    // Connect once the frame has loaded (or after 2 s if its load event fired before this effect ran).
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      void go();
    };
    el.addEventListener("load", start);
    const t = setTimeout(start, 2_000);
    return () => {
      cancelled = true;
      clearTimeout(t);
      el.removeEventListener("load", start);
    };
  }, [modelId, sdkKey, kitKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <iframe key={`${modelId}-${kitKey}`} ref={frame} className="adm-tour" src={src} title="Matterport 3D tour of the floor" allow="xr-spatial-tracking; fullscreen" allowFullScreen />
      <p className="small muted">
        {note}{" "}
        <a href={`https://my.matterport.com/show/?m=${encodeURIComponent(modelId)}`} target="_blank" rel="noreferrer">
          Open tour
        </a>
      </p>
    </>
  );
}
