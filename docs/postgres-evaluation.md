# SQLite → Postgres Evaluation

Date: 2026-10-31. Question: should this app move from SQLite to Postgres? **Short answer: no — stay on SQLite.** This doc records the measured current state, the evaluation, what to improve instead, and what would trigger a revisit.

## 1. Current state (measured)

- **Driver:** built-in `node:sqlite` (`DatabaseSync`, Node ≥ 22). Zero database dependencies in `package.json` — no `pg`, no `better-sqlite3`, no ORM.
- **DB files (live, this host):** `data/tab-automation.db` 1.4 MB + `-wal` 4.0 MB + `-shm` 32 KB; `data/dashboard.db` 20 KB (WAL clean, 0-byte `-wal`). A stray 0-byte `data/tab.db` exists (unused).
- **Journal mode:** WAL, set via `PRAGMA journal_mode = WAL` in both `src/db.js` (`openDb`) and `src/dashboard-db.js`. See [WAL vs rollback review](sqlite-wal-vs-rollback.md).
- **Schema:** 31 user tables in the main DB (`sqlite_sequence` excluded) + 2 in the dashboard DB (`dashboard_settings`, `dashboard_views`). All schema is `CREATE TABLE IF NOT EXISTS` inline in `src/db.js` (~1250 lines) plus ad-hoc `ALTER TABLE` migrations in `ensureDb`.
- **Access layer:** 83 exported helper functions in `src/db.js` (measured via `grep -c "^export function"`); all SQL is hand-written prepared statements, no query builder.
- **Consumers:** 20 source files import `db.js`/`dashboard-db.js` (`src/index.js`, `src/workflow.js`, `src/scheduler.js`, `src/discord.js`, `src/agent.js`, `src/planner.js`, `src/todos.js`, `src/validate.js`, `src/headless-dashboard.js`, `src/loop/store.js`, 6 route modules, 3 service modules) plus ~15 backend test files. Single-process, single-host deployment (Samsung Tab via Termux; see `package.json` description).
- **Gaps (confirmed by grep):** no `busy_timeout`, no `SQLITE_BUSY` retry, no explicit checkpointing, no `VACUUM`, no automated backup — only a one-off `data/backups/db-reset-<ts>/` snapshot. The live `-wal` (4 MB) already exceeds the main DB file (1.4 MB), i.e. checkpoint hygiene is the concrete pain point, not engine choice.

## 2. Evaluation

**Scale.** 1.4 MB of data and ~33 tables is three orders of magnitude below where Postgres starts to matter. SQLite handles multi-GB single-file DBs; growth headroom is ample.

**Concurrency.** The app is a single Node process (one `DatabaseSync` handle per DB) with a low write rate: a 30 s scheduler loop, Discord event handlers, and dashboard reads. WAL already gives non-blocking readers. No evidence of write contention — and if it ever appears, `busy_timeout` + retry fixes it without a new engine.

**Termux constraint.** This is decisive. The target runtime is a Samsung tablet running Termux. `node:sqlite` ships with Node 22 — zero native addons, zero services to install or supervise. Running Postgres on Termux means a second package, a supervised daemon, storage/RAM pressure on a tablet, and a new failure domain for an always-on bot. The app's existing docs explicitly chose built-in SQLite as "Termux-safe" (see `docs/dashboard-upgrade-plan.md`).

**Ops cost.** Postgres buys nothing here and costs: provisioning, backups, connection management, schema migration tooling (today: zero), and rewriting 83 helpers plus 20 consumers' worth of SQL dialect differences (`AUTOINCREMENT`, `ON CONFLICT` subtleties, `TEXT` timestamps, `?` vs `$1` placeholders). It also breaks the test suite's file-DB fixture pattern (`test/backend/_fixture.js`).

**What Postgres would genuinely add** — concurrent writers, network access, rich types, `LISTEN/NOTIFY`, point-in-time recovery — maps to no current requirement. The dashboard reads the same local files; there is no second host, no multi-user hosted tier.

## 3. Verdict: STAY on SQLite

Do not migrate. The engine fits the workload, the platform, and the team size. Spend the effort on §4 instead.

## 4. Stay-on-SQLite improvements (recommended, in priority order)

1. **WAL checkpoint hygiene.** Set `PRAGMA journal_size_limit` (e.g. 8–16 MB) and run `PRAGMA wal_checkpoint(PASSIVE)` (or `TRUNCATE` on idle/scheduler tick). Evidence of need: live `-wal` is 4 MB vs 1.4 MB DB.
2. **`SQLITE_BUSY` resilience.** Set `PRAGMA busy_timeout = 5000` in both `openDb` and `openDashboardDb`, and add a small retry-with-backoff wrapper around write transactions for the scheduler + worker paths.
3. **Online backup.** Use a periodic `VACUUM INTO 'data/backups/<ts>.db'` (SQLite 3.27+) or the `sqlite3 .backup` equivalent — never a raw file copy of a live WAL-mode DB. Keep N most recent; document restore as maintenance-only with reconciliation (per `docs/dashboard-upgrade-plan.md` §rollback).
4. **Minor:** remove or document the stray 0-byte `data/tab.db`; consider `PRAGMA synchronous = NORMAL` (safe in WAL, less fsync pressure on tablet flash) and `PRAGMA foreign_keys = ON` if cascade deletes are relied upon (schema declares `ON DELETE CASCADE` but nothing enables FK enforcement).

## 5. Future migration sketch (if §6 ever fires)

Keep this deliberately rough — it is a contingency, not a plan:

1. **Repository layer.** Wrap the 83 helpers behind a narrow interface (per-domain modules: runs, jobs, automations, kv, …) so call sites stop touching SQL/placeholders directly. No behavior change.
2. **Postgres driver.** Add `pg`, implement the repository interface against it, translate schema (sequences for `AUTOINCREMENT`, `$n` placeholders, timestamptz). Keep SQLite implementation side by side.
3. **Dual-write + verify.** Write to both, read from SQLite; background job diffs row counts/hashes per table until clean for a soak period.
4. **Cutover.** Flip reads to Postgres behind a flag, keep SQLite as rollback for one release, then retire. Migrate tests to `pg-mem` or ephemeral Postgres.

Estimated cost even then: medium — the 83-function surface and 20 consumers are the long tail, not the schema.

## 6. Revisit triggers

Re-open this decision only if one of these becomes true:

- **Multi-host:** a second process/host must write concurrently (Termux-only deployment ends).
- **Sustained write contention:** `SQLITE_BUSY` retries firing regularly despite `busy_timeout`, or WAL checkpoint starvation under load.
- **Multi-user hosted dashboard:** the dashboard becomes a network service with its own user/tenant load rather than a local Control Room over local files.

Until then: stay on SQLite, do §4, close this out.
