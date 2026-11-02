import Database from "better-sqlite3";
import type {
  TripBrief,
  TripFault,
  TripIndexEntry,
  TripPlan,
  TripResearch,
  TripSources,
} from "@pi-demo/shared";
import type { SearchCache } from "../trips/docs";

export type DocMap = {
  brief: TripBrief;
  plan: TripPlan;
  sources: TripSources;
  research: TripResearch;
  searchCache: SearchCache;
  faults: TripFault[];
};
export type DocKind = keyof DocMap;

const INITIAL: { [K in DocKind]: () => DocMap[K] } = {
  brief: () => ({}),
  plan: () => ({ days: [] }),
  sources: () => ({}),
  research: () => ({ searchCount: 0, fetchCount: 0 }),
  searchCache: () => ({}),
  faults: () => [],
};

const MAX_FAULTS = 10;

export type InflightRun = {
  tripId: string;
  runId: string;
  userMessageId: string;
  userText: string;
  attempts: number;
  startedAt: string;
};

export type NewInflightRun = Omit<InflightRun, "attempts">;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS trips (
    trip_id TEXT PRIMARY KEY,
    entry TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS trip_docs (
    trip_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (trip_id, kind)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    trip_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS inflight (
    trip_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    user_message_id TEXT NOT NULL,
    user_text TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL
  );
`;

type InflightRow = {
  trip_id: string;
  run_id: string;
  user_message_id: string;
  user_text: string;
  attempts: number;
  started_at: string;
};

const toInflight = (row: InflightRow): InflightRun => ({
  tripId: row.trip_id,
  runId: row.run_id,
  userMessageId: row.user_message_id,
  userText: row.user_text,
  attempts: row.attempts,
  startedAt: row.started_at,
});

export class TripStore {
  private constructor(private readonly db: Database.Database) {}

  /** Opens (and migrates) the store. `":memory:"` is allowed for tests. */
  static open(path: string): TripStore {
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.exec(SCHEMA);
    return new TripStore(db);
  }

  close(): void {
    this.db.close();
  }

  /** Runs `fn` atomically; nested calls become savepoints. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  upsertTrip(entry: TripIndexEntry): void {
    this.db
      .prepare(
        `INSERT INTO trips (trip_id, entry, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(trip_id) DO UPDATE SET entry = excluded.entry, updated_at = excluded.updated_at`,
      )
      .run(entry.tripId, JSON.stringify(entry), entry.updatedAt);
  }

  listTrips(): TripIndexEntry[] {
    const rows = this.db
      .prepare("SELECT entry FROM trips ORDER BY updated_at DESC")
      .all() as { entry: string }[];
    return rows.map((row) => JSON.parse(row.entry) as TripIndexEntry);
  }

  getTrip(tripId: string): TripIndexEntry | undefined {
    const row = this.db.prepare("SELECT entry FROM trips WHERE trip_id = ?").get(tripId) as
      | { entry: string }
      | undefined;
    return row === undefined ? undefined : (JSON.parse(row.entry) as TripIndexEntry);
  }

  getDoc<K extends DocKind>(tripId: string, kind: K): DocMap[K] {
    const row = this.db
      .prepare("SELECT value FROM trip_docs WHERE trip_id = ? AND kind = ?")
      .get(tripId, kind) as { value: string } | undefined;
    return row === undefined
      ? (INITIAL[kind] as () => DocMap[K])()
      : (JSON.parse(row.value) as DocMap[K]);
  }

  setDoc<K extends DocKind>(tripId: string, kind: K, value: DocMap[K]): void {
    this.db
      .prepare(
        `INSERT INTO trip_docs (trip_id, kind, value) VALUES (?, ?, ?)
         ON CONFLICT(trip_id, kind) DO UPDATE SET value = excluded.value`,
      )
      .run(tripId, kind, JSON.stringify(value));
  }

  appendFault(tripId: string, fault: TripFault): void {
    this.transaction(() => {
      const items = this.getDoc(tripId, "faults");
      this.setDoc(tripId, "faults", [...items, fault].slice(-MAX_FAULTS));
    });
  }

  clearFaults(tripId: string): void {
    this.setDoc(tripId, "faults", []);
  }

  getSessionId(tripId: string): string | undefined {
    const row = this.db.prepare("SELECT session_id FROM sessions WHERE trip_id = ?").get(tripId) as
      | { session_id: string }
      | undefined;
    return row?.session_id;
  }

  setSessionId(tripId: string, sessionId: string): void {
    this.db
      .prepare(
        `INSERT INTO sessions (trip_id, session_id) VALUES (?, ?)
         ON CONFLICT(trip_id) DO UPDATE SET session_id = excluded.session_id`,
      )
      .run(tripId, sessionId);
  }

  clearSessionId(tripId: string): void {
    this.db.prepare("DELETE FROM sessions WHERE trip_id = ?").run(tripId);
  }

  beginRun(run: NewInflightRun): void {
    this.db
      .prepare(
        `INSERT INTO inflight (trip_id, run_id, user_message_id, user_text, attempts, started_at)
         VALUES (?, ?, ?, ?, 0, ?)
         ON CONFLICT(trip_id) DO UPDATE SET run_id = excluded.run_id,
           user_message_id = excluded.user_message_id, user_text = excluded.user_text,
           attempts = 0, started_at = excluded.started_at`,
      )
      .run(run.tripId, run.runId, run.userMessageId, run.userText, run.startedAt);
  }

  touchRun(tripId: string, runId: string, startedAt: string): void {
    this.db
      .prepare("UPDATE inflight SET run_id = ?, started_at = ? WHERE trip_id = ?")
      .run(runId, startedAt, tripId);
  }

  bumpAttempts(tripId: string): number {
    this.db.prepare("UPDATE inflight SET attempts = attempts + 1 WHERE trip_id = ?").run(tripId);
    return this.getInflight(tripId)?.attempts ?? 0;
  }

  endRun(tripId: string): void {
    this.db.prepare("DELETE FROM inflight WHERE trip_id = ?").run(tripId);
  }

  getInflight(tripId: string): InflightRun | undefined {
    const row = this.db.prepare("SELECT * FROM inflight WHERE trip_id = ?").get(tripId) as
      | InflightRow
      | undefined;
    return row === undefined ? undefined : toInflight(row);
  }

  listInflight(): InflightRun[] {
    const rows = this.db
      .prepare("SELECT * FROM inflight ORDER BY started_at ASC")
      .all() as InflightRow[];
    return rows.map(toInflight);
  }
}
