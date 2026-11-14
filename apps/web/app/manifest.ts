import type { MetadataRoute } from "next";

/** The companion app's web app manifest (Field Kit colors). Icons are drawn at build time (app/icons, app/icon.tsx). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/app",
    name: "Clara",
    short_name: "Clara",
    description: "Clara's volunteer app: alerts for first-aid emergencies and patient rides near you. HackPrinceton demo; never replaces emergency services.",
    start_url: "/app",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#18181B",
    theme_color: "#18181B",
    categories: ["medical", "health"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
