import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** A JSON (and binary) cache in a gitignored folder (default `.placement-cache/` at the repo root). */
export interface Cache {
  dir: string;
  get<T>(key: string): T | null;
  set(key: string, value: unknown): void;
  getBytes(name: string): Buffer | null;
  setBytes(name: string, bytes: Buffer): void;
}

const safe = (key: string) => key.replace(/[^a-zA-Z0-9._-]+/g, "_");

/** Walk up from `start` to the folder whose package.json declares workspaces (the repo root). */
export function repoRoot(start = process.cwd()): string {
  let dir = resolve(start);
  for (let i = 0; i < 8; i++) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        if ((JSON.parse(readFileSync(pkg, "utf8")) as { workspaces?: unknown }).workspaces) return dir;
      } catch {
        /* keep walking */
      }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return resolve(start);
}

export function fileCache(dir = process.env.PLACEMENT_CACHE_DIR || join(repoRoot(), ".placement-cache")): Cache {
  const ensure = () => {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  };
  return {
    dir,
    get<T>(key: string): T | null {
      const f = join(dir, `${safe(key)}.json`);
      if (!existsSync(f)) return null;
      try {
        return JSON.parse(readFileSync(f, "utf8")) as T;
      } catch {
        return null;
      }
    },
    set(key, value) {
      ensure();
      writeFileSync(join(dir, `${safe(key)}.json`), JSON.stringify(value));
    },
    getBytes(name) {
      const f = join(dir, safe(name));
      return existsSync(f) ? readFileSync(f) : null;
    },
    setBytes(name, bytes) {
      ensure();
      writeFileSync(join(dir, safe(name)), bytes);
    },
  };
}

/** An in-memory cache (tests). */
export function memoryCache(): Cache {
  const m = new Map<string, unknown>();
  const b = new Map<string, Buffer>();
  return {
    dir: ":memory:",
    get: <T,>(k: string) => (m.has(k) ? (m.get(k) as T) : null),
    set: (k, v) => void m.set(k, JSON.parse(JSON.stringify(v))),
    getBytes: (n) => b.get(n) ?? null,
    setBytes: (n, bytes) => void b.set(n, bytes),
  };
}
