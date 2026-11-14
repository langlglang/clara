import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  // Keep `next dev` from writing an AGENTS.md into apps/web (the repo root has the project one).
  agentRules: false,
  // The shared packages ship TypeScript source; Next compiles them with the app.
  transpilePackages: ["@clara/contracts", "@clara/network", "@clara/agent", "@clara/coordinator"],
  // The coordinator loads LangChain / deepagents lazily on the server; keep them as plain Node packages, unbundled.
  serverExternalPackages: ["deepagents", "langchain", "@langchain/core", "@langchain/langgraph", "@langchain/anthropic", "langsmith", "web-push"],
  // The packages use NodeNext imports ("./alerts.js" for alerts.ts). Turbopack does not map those yet, so the app
  // builds and runs with webpack (see package.json scripts), which does with extensionAlias.
  webpack(config: { resolve: { extensionAlias?: Record<string, string[]> } }) {
    config.resolve.extensionAlias = { ...config.resolve.extensionAlias, ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // The companion app asks for the browser's location at sign-up; nothing asks for the mic or camera.
          { key: "Permissions-Policy", value: "microphone=(), camera=(), geolocation=(self)" },
        ],
      },
      {
        // The companion service worker lives at the root, so its scope is "/" without Service-Worker-Allowed.
        // Never cache it, so an update reaches phones on their next visit.
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
};

export default config;
