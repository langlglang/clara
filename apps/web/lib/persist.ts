import pg from "pg";
import { SNAPSHOT_VERSION, type PersistenceStatus, type RuntimeState } from "./snapshot";

/**
 * Snapshot persistence to Postgres (only when DATABASE_URL is set). The runtime stays synchronous and in memory;
 * this module loads one JSON snapshot (row id 'main' of clara_snapshot) before the first request is served, then
 * writes the whole state back when it changed, at most every SAVE_EVERY_MS, plus once more on SIGTERM/SIGINT.
 *
 * Two instances during a deploy: each snapshot carries the writer's `generation` (its start time). The save is one
 * conditional upsert that only lands when the stored generation is not newer than ours, so once the new instance
 * has saved, the old one's later saves (its final SIGTERM save included) are refused and it stops saving.
 * Remaining window: changes the old instance accepts after the new one loaded are lost (seconds, while Render
 * switches traffic over).
 *
 * A database failure never crashes the app or blocks a request: it is logged, reported on /api/state, and the
 * server keeps running in memory. If the first load fails, this instance does not save at all, so it can't
 * overwrite the saved copy with a fresh demo seed.
 */

export const SAVE_EVERY_MS = 2_000;
export const STATEMENT_TIMEOUT_MS = 5_000;
export const FINAL_SAVE_MS = 5_000;
const LOAD_ATTEMPTS = 3;
const MAX_BACKOFF_MS = 30_000;
export const SNAPSHOT_ID = "main";

export const SQL = {
  create: "CREATE TABLE IF NOT EXISTS clara_snapshot (id text PRIMARY KEY, data jsonb NOT NULL, saved_at timestamptz NOT NULL)",
  load: "SELECT data, saved_at FROM clara_snapshot WHERE id = $1::text",
  /** $1 id, $2 data, $3 our generation. Lands only when the stored generation is not newer (a missing or non-numeric one counts as 0). */
  save: `INSERT INTO clara_snapshot (id, data, saved_at) VALUES ($1::text, $2::jsonb, now())
ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, saved_at = EXCLUDED.saved_at
WHERE (CASE WHEN jsonb_typeof(clara_snapshot.data -> 'generation') = 'number' THEN (clara_snapshot.data ->> 'generation')::numeric ELSE 0 END) <= $3::numeric
RETURNING saved_at`,
  /** Keeps a copy of a snapshot this server couldn't read ($1 the copy's id, $2 the id copied) before it is overwritten. */
  keepRejected: "INSERT INTO clara_snapshot (id, data, saved_at) SELECT $1::text, data, saved_at FROM clara_snapshot WHERE id = $2::text ON CONFLICT (id) DO NOTHING",
} as const;

/** The part of pg's Pool this module uses (a fake in tests). */
export interface PgLike {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  end?(): Promise<void>;
}

export interface PersistenceOptions {
  /** DATABASE_URL; used when `db` isn't given. */
  url?: string;
  db?: PgLike;
  /** This instance's generation (default: its start time in ms). */
  generation?: number;
  saveEveryMs?: number;
  /** Start the save interval on attach (default true; tests call saveNow). */
  timers?: boolean;
  log?: (line: string) => void;
  now?: () => Date;
}

export interface LoadResult {
  /** The query worked (false: the database couldn't be read; this instance then never saves). */
  ok: boolean;
  /** The stored snapshot as pg returned it (null: no row yet). */
  raw: unknown;
}

export interface Persistence {
  readonly status: PersistenceStatus;
  load(): Promise<LoadResult>;
  /** Copies the stored snapshot aside (as `rejected-<time>`) before a fresh start overwrites it. */
  keepRejected(reason: string): Promise<void>;
  /** Starts saving `source` (claims this generation at once, then saves on change). */
  attach(source: { exportState(): RuntimeState }, restoredFrom: string | null): void;
  /** Saves now if the state changed (or `force`). Resolves true when the database has this state. Never throws. */
  saveNow(force?: boolean): Promise<boolean>;
  /** The final save before the process stops (bounded by FINAL_SAVE_MS). */
  flush(): Promise<void>;
  stop(): void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

export function createPool(url: string, log: (line: string) => void): PgLike {
  const pool = new pg.Pool({
    connectionString: url,
    max: 3,
    connectionTimeoutMillis: STATEMENT_TIMEOUT_MS,
    idleTimeoutMillis: 30_000,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    query_timeout: STATEMENT_TIMEOUT_MS + 1_000,
    application_name: "clara-web",
  });
  // An idle client losing its connection emits here; unhandled, it would crash the process.
  pool.on("error", (error) => log(`[persist] database connection error: ${message(error)}`));
  return pool as unknown as PgLike;
}

export function createPersistence(options: PersistenceOptions): Persistence {
  const log = options.log ?? ((line: string) => console.log(line));
  const now = options.now ?? (() => new Date());
  const generation = options.generation ?? Date.now();
  const saveEveryMs = options.saveEveryMs ?? SAVE_EVERY_MS;
  let db: PgLike | null = options.db ?? null;
  const getDb = (): PgLike => (db ??= createPool(options.url ?? "", log));

  const status: PersistenceStatus = { enabled: true, saving: false, last_saved_at: null, last_error: null, restored_from: null, generation };
  let source: { exportState(): RuntimeState } | null = null;
  let canSave = true;
  let lastBody: string | null = null;
  let inFlight: Promise<boolean> | null = null;
  let failures = 0;
  let nextTryAt = 0;
  let interval: ReturnType<typeof setInterval> | null = null;
  let table: Promise<unknown> | null = null;

  const ensureTable = () => {
    table ??= getDb()
      .query(SQL.create)
      .catch((error: unknown) => {
        table = null;
        throw error;
      });
    return table;
  };

  const stopSaving = (why: string) => {
    canSave = false;
    status.saving = false;
    status.last_error = why;
    if (interval) clearInterval(interval);
    interval = null;
  };

  async function write(force: boolean): Promise<boolean> {
    if (!source || !canSave) return false;
    const state = source.exportState();
    const body = JSON.stringify(state);
    if (!force && body === lastBody) return true;
    const savedAt = now().toISOString();
    const data = JSON.stringify({ version: SNAPSHOT_VERSION, saved_at: savedAt, generation, ...state });
    try {
      await ensureTable();
      const result = await getDb().query(SQL.save, [SNAPSHOT_ID, data, generation]);
      if (!result.rowCount) {
        log("[persist] a newer server instance has saved its state; this instance stops saving (its later changes are not kept).");
        stopSaving("A newer server instance took over saving; this one stopped.");
        return false;
      }
      lastBody = body;
      failures = 0;
      nextTryAt = 0;
      status.last_saved_at = savedAt;
      status.last_error = null;
      return true;
    } catch (error) {
      failures += 1;
      nextTryAt = Date.now() + Math.min(MAX_BACKOFF_MS, saveEveryMs * 2 ** failures);
      status.last_error = `Save failed: ${message(error)}`;
      log(`[persist] save failed (${failures} in a row), still running in memory: ${message(error)}`);
      return false;
    }
  }

  const persistence: Persistence = {
    status,
    async load() {
      let last: unknown = null;
      for (let attempt = 1; attempt <= LOAD_ATTEMPTS; attempt++) {
        try {
          await ensureTable();
          const result = await getDb().query(SQL.load, [SNAPSHOT_ID]);
          const row = result.rows[0];
          return { ok: true, raw: row ? row.data : null };
        } catch (error) {
          last = error;
          log(`[persist] loading the saved state failed (attempt ${attempt} of ${LOAD_ATTEMPTS}): ${message(error)}`);
          if (attempt < LOAD_ATTEMPTS) await sleep(1_000 * attempt);
        }
      }
      stopSaving(`Couldn't read the saved state (${message(last)}); running in memory and not saving, so the saved copy is kept. Restart once the database is reachable.`);
      log(`[persist] ${status.last_error}`);
      return { ok: false, raw: null };
    },
    async keepRejected(reason) {
      const id = `rejected-${now().toISOString()}`;
      try {
        await getDb().query(SQL.keepRejected, [id, SNAPSHOT_ID]);
        log(`[persist] kept the unreadable snapshot as '${id}' (${reason}).`);
      } catch (error) {
        log(`[persist] couldn't keep a copy of the unreadable snapshot: ${message(error)}`);
      }
    },
    attach(next, restoredFrom) {
      source = next;
      status.restored_from = restoredFrom;
      if (!canSave) return;
      status.saving = true;
      // Claim this generation now, so an older instance still running stops overwriting.
      void persistence.saveNow(true);
      if (options.timers !== false) {
        interval = setInterval(() => {
          if (inFlight || Date.now() < nextTryAt) return;
          void persistence.saveNow();
        }, saveEveryMs);
        interval.unref?.();
      }
    },
    saveNow(force = false) {
      if (inFlight) return inFlight.then(() => persistence.saveNow(force));
      inFlight = write(force).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    async flush() {
      if (interval) clearInterval(interval);
      interval = null;
      if (!source || !canSave) return;
      const done = await Promise.race([persistence.saveNow().then((ok) => (ok ? "saved" : "not saved")), sleep(FINAL_SAVE_MS).then(() => "timed out")]);
      log(`[persist] final save: ${done}.`);
    },
    stop() {
      if (interval) clearInterval(interval);
      interval = null;
      void db?.end?.().catch(() => undefined);
    },
  };
  return persistence;
}
