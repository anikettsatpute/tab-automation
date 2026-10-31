# SQLite: WAL Mode vs Rollback Journal — Short Review

SQLite guarantees atomic commits and durability through a journal mode. The two main modes are the legacy **rollback journal** (default) and **Write-Ahead Logging (WAL)**. The mode is per-database, set via `PRAGMA journal_mode=WAL;`.

## How Each Works

**Rollback journal (delete/persist/truncate).** Before overwriting the database file, SQLite copies the original pages into a separate `-journal` file. It then writes changed pages in place into the `.db` file, fsyncs, and deletes/clears the journal on commit. On rollback or crash recovery, the journal's pages are restored. Readers and writers contend on the same database file, so a writer blocks readers (and vice versa).

**WAL.** Writers append new versions of changed pages to a separate `-wal` file and commit with a single fsync in the common case, leaving the main `.db` file untouched. Readers check the WAL first (via the `-shm` shared-memory index) and fall back to the `.db` file. A **checkpoint** operation later copies WAL frames back into the `.db` file. Readers and one writer can proceed concurrently.

## Pros and Cons

| Aspect | Rollback journal | WAL |
|---|---|---|
| Write speed | Baseline; more random I/O and fsyncs per commit | **Faster in most cases**; more sequential I/O, fewer fsyncs, less exposure to broken `fsync()` implementations |
| Concurrency | Writer blocks readers; readers block writer | **Readers don't block the writer, writer doesn't block readers**; one concurrent writer still |
| Read-heavy workloads | Slightly faster (~1–2%) when writes are rare | Marginally slower on pure-read workloads |
| Extra files | `-journal` only during a txn (deleted/zeroed after commit) | Persistent `-wal` + `-shm` sidecar files while in WAL mode |
| Checkpointing | No checkpoint step | Needs periodic checkpoints; a busy reader set can delay checkpointing and let the WAL grow |
| Network filesystem | Works | **Does not work reliably** — all connections must be on the same host |
| Attached databases | Multi-DB transactions are atomic across the set | Atomic per-database only, **not atomic across ATTACHed DBs** |
| Page size changes | Allowed (`VACUUM`, restore, fresh DB) | **Not allowed in WAL mode** — must switch back to rollback journal first |
| Compatibility / access | Universal; simple single-file format, easy read-only open | Requires SQLite 3.7.0+ with shared-memory VFS support; read-only open needs a valid `-shm`/`-wal` state, so less suited as an app file format |

## When to Use Each

- **Use WAL** as the default for server-side, desktop, and mobile apps with concurrent readers and writers on local storage. It is the best choice for most OLTP-style SQLite workloads.
- **Use rollback journal** when: the database lives on a **network filesystem**; the database is distributed as a **single-file application document**; consumers need **read-only or maximal-compatibility** access (older SQLite, no shm); transactions must stay **atomic across ATTACHed databases**; or you need to **change `page_size`**.

## Verdict

Prefer WAL unless one of its documented limitations applies to you — network storage, app-file-format distribution, cross-database atomicity, or page-size changes. Otherwise WAL's speed and non-blocking reads are a strict upgrade over the rollback journal.

## Sources

- [Write-Ahead Logging — sqlite.org/wal.html](https://www.sqlite.org/wal.html)
