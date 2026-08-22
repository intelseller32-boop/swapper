/* ============================================================
   Standalone DB → DB migrator
   ------------------------------------------------------------
   Deploy this as its OWN, separate Railway project/service.
   It does NOT touch your existing app's code at all.

   What it does:
   - Reads two environment variables you set on THIS service:
       OLD_MYSQL_URL  → your OLD database (source, has the real data)
       NEW_MYSQL_URL  → your NEW database (target, gets overwritten)
   - On boot, copies every table (schema + all rows) from OLD → NEW,
     server-to-server on Railway's own network — your phone is never
     in the data path, so it's fast and won't die if your phone loses
     signal.
   - Starts a tiny web server so you can open this service's own
     Railway URL from your phone and watch live progress, instead of
     digging through logs.

   ⚠️ DESTRUCTIVE on the NEW database: every table found in OLD gets
   DROP TABLE IF EXISTS + recreated + refilled on NEW. Only point
   NEW_MYSQL_URL at a database you're fine with being fully overwritten.
   ============================================================ */

import express from "express";
import mysql   from "mysql2/promise";

const app  = express();
const PORT = process.env.PORT || 3000;

const OLD_MYSQL_URL = process.env.OLD_MYSQL_URL;
const NEW_MYSQL_URL = process.env.NEW_MYSQL_URL;

/* Optional: set MIGRATION_ACCESS_KEY on this service and then open
   your-service-url?key=whatever to view status. Leave unset to allow
   open access to the status page (fine for a short-lived throwaway
   service you'll delete right after). */
const ACCESS_KEY = process.env.MIGRATION_ACCESS_KEY || null;

const job = {
  status: "idle",       // idle | missing-config | scanning | running | success | error | success-with-errors
  message: "Starting up...",
  tablesTotal: 0,
  tablesDone: 0,
  currentTable: null,
  rowsCopied: 0,
  rowsSkipped: 0,
  failedTables: [],
  startedAt: null,
  finishedAt: null,
  /* Snapshot taken once, up front, before any copying starts. Everything
     the migration targets is fixed at this point — rows inserted into the
     source DB *after* the scan (this is a live table) are intentionally
     NOT picked up, so the total/ETA stays meaningful and we don't chase
     a moving target. */
  totalRowsPlanned: 0,
  tableRowPlan: {},   // { tableName: rowCountAtScanTime }
  etaSeconds: null,
  rowsPerSecond: 0,
  log: []
};

function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  job.log.push(line);
  if (job.log.length > 500) job.log.shift(); // keep it bounded
}

/* Retries a flaky async DB call a few times with backoff — covers
   transient network blips between the two Railway services, so a
   one-off hiccup doesn't kill the whole run. */
async function withRetry(fn, label, retries = 3, delayMs = 1500) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        logLine(`  (retry ${attempt}/${retries - 1} for ${label}: ${e.message})`);
        await new Promise(r => setTimeout(r, delayMs * attempt));
      }
    }
  }
  throw lastErr;
}

/* Converts a single JS value (as returned by mysql2 from the SOURCE db)
   into something safe to hand to escape() for the TARGET db, no matter
   what MySQL type it originally came from:
     - null / undefined        → left as null
     - Buffer (BLOB/BINARY)    → left as-is, escape() emits a hex literal
     - Date (DATETIME/DATE)    → left as-is, escape() formats it correctly
     - bigint (big BIGINT)     → stringified so it isn't mangled
     - plain object / array
       (JSON columns, which
        mysql2 auto-decodes)   → JSON.stringify'd back into JSON text
     - everything else
       (string/number/bool)   → left as-is */
function serializeValue(v) {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Date) return v;
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "object") return JSON.stringify(v);
  return v;
}

function buildInsertSql(table, cols, rows, tgt) {
  const colList = cols.map(c => `\`${c}\``).join(", ");
  const valueLines = rows.map(r =>
    "(" + cols.map(c => tgt.escape(serializeValue(r[c]))).join(", ") + ")"
  );
  return `INSERT INTO \`${table}\` (${colList}) VALUES ${valueLines.join(",")}`;
}

/* Finds the PRIMARY KEY column(s) for a table so pagination can use a
   stable ORDER BY. Without this, OFFSET-based paging over a table that's
   still being written to (rows inserted/deleted mid-scan) can re-fetch
   or skip rows as they shift position — that's what caused duplicate-key
   errors and lost/re-counted rows during auth_data's migration. */
async function getPrimaryKeyCols(src, table) {
  const [rows] = await src.query(
    `SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'
     ORDER BY ORDINAL_POSITION`,
    [table]
  );
  return rows.map(r => r.COLUMN_NAME);
}

/* Recomputes the live rows/sec rate and ETA off the fixed totalRowsPlanned
   snapshot, and refreshes job.eta fields. Called periodically while
   copying so the status page stays live without recalculating on every
   single row. */
function updateEta() {
  if (!job.startedAt || !job.totalRowsPlanned) return;
  const elapsedSec = (Date.now() - new Date(job.startedAt).getTime()) / 1000;
  const processed = job.rowsCopied + job.rowsSkipped;
  if (elapsedSec <= 0 || processed <= 0) return;
  job.rowsPerSecond = Math.round((processed / elapsedSec) * 10) / 10;
  const remaining = Math.max(0, job.totalRowsPlanned - processed);
  job.etaSeconds = job.rowsPerSecond > 0 ? Math.round(remaining / job.rowsPerSecond) : null;
}

function formatDuration(sec) {
  if (sec === null || sec === undefined) return "-";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60), rm = m % 60;
  return `${h}h ${rm}m`;
}

function checkKey(req, res) {
  if (!ACCESS_KEY) return true;
  if (req.query.key === ACCESS_KEY) return true;
  res.status(403).send("Forbidden — add ?key=YOUR_MIGRATION_ACCESS_KEY to the URL.");
  return false;
}

app.get("/status", (req, res) => {
  if (!checkKey(req, res)) return;
  res.json(job);
});

app.get("/", (req, res) => {
  if (!checkKey(req, res)) return;
  const keyParam = ACCESS_KEY ? `?key=${encodeURIComponent(ACCESS_KEY)}` : "";
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="4">
  <title>DB Migration Status</title>
  <style>
    body { font-family: monospace; background:#0d1117; color:#c9d1d9; padding:20px; }
    h1 { color:#58a6ff; font-size:18px; }
    .ok { color:#3fb950; } .err { color:#f85149; } .run { color:#d29922; }
    pre { background:#161b22; padding:12px; border-radius:8px; overflow-x:auto; white-space:pre-wrap; }
    .bar-bg { background:#21262d; border-radius:6px; height:14px; overflow:hidden; margin:10px 0; }
    .bar { background:#3fb950; height:100%; transition:width .3s; }
  </style>
</head>
<body>
  <h1>🔄 DB Migration Status</h1>
  <p>Status: <b class="${job.status === 'success' ? 'ok' : job.status === 'error' ? 'err' : 'run'}">${job.status}</b></p>
  ${job.totalRowsPlanned ? `<p><small>Planned at scan time: ${job.totalRowsPlanned} rows across ${job.tablesTotal} tables.</small></p>` : ""}
  <p>${job.message}</p>
  <div class="bar-bg"><div class="bar" style="width:${job.totalRowsPlanned ? Math.round((job.rowsCopied + job.rowsSkipped) / job.totalRowsPlanned * 100) : (job.tablesTotal ? Math.round(job.tablesDone / job.tablesTotal * 100) : 0)}%"></div></div>
  <p>Tables: ${job.tablesDone} / ${job.tablesTotal} &nbsp; | &nbsp; Rows: ${job.rowsCopied + job.rowsSkipped} / ${job.totalRowsPlanned || "?"} planned &nbsp; | &nbsp; Copied: ${job.rowsCopied} &nbsp; | &nbsp; Skipped: ${job.rowsSkipped}</p>
  <p>Speed: ${job.rowsPerSecond || 0} rows/sec &nbsp; | &nbsp; ETA: ${formatDuration(job.etaSeconds)}</p>
  <p>Current table: ${job.currentTable || "-"}</p>
  <p>Started: ${job.startedAt || "-"} &nbsp; Finished: ${job.finishedAt || "-"}</p>
  ${job.failedTables.length ? `<p class="err">Tables with issues: ${job.failedTables.join(", ")}</p>` : ""}
  <p><small>Page auto-refreshes every 4s. JSON: <a style="color:#58a6ff" href="/status${keyParam}">/status</a></small></p>
  <h3>Recent log</h3>
  <pre>${job.log.slice(-60).join("\n")}</pre>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`[db-migrator] listening on :${PORT}`);
  runMigration();
});

async function runMigration() {
  if (!OLD_MYSQL_URL || !NEW_MYSQL_URL) {
    job.status = "missing-config";
    job.message = "Set OLD_MYSQL_URL and NEW_MYSQL_URL in this service's Variables, then redeploy.";
    logLine(job.message);
    return;
  }

  job.status = "running";
  job.message = "Connecting to both databases...";
  job.startedAt = new Date().toISOString();
  logLine(job.message);

  let src, tgt;
  try {
    src = await mysql.createConnection({
      uri: OLD_MYSQL_URL,
      timezone: "+00:00",
      supportBigNumbers: true,   // BIGINT/DECIMAL come back as strings, not
      bigNumberStrings: true,    // lossy JS numbers or raw BigInt.
      dateStrings: false
    });
    tgt = await mysql.createConnection({
      uri: NEW_MYSQL_URL,
      timezone: "+00:00",
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: false
    });
    logLine("Connected to source and target databases.");

    await tgt.query("SET FOREIGN_KEY_CHECKS=0");
    await tgt.query("SET SQL_MODE=''"); // don't let strict mode reject rows the source db itself accepted

    const [tables] = await src.query(
      "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name"
    );
    job.tablesTotal = tables.length;
    logLine(`Found ${tables.length} tables to migrate.`);

    /* ---- Pre-scan: count every table BEFORE touching any data ----
       This fixes the total size of the job up front. Rows are still
       being written to the source DB during a long migration (it's
       live), but anything inserted after this point is intentionally
       excluded from the count and from what gets copied — we migrate
       exactly the snapshot we planned, not a moving target, so the
       total and ETA stay accurate throughout the run. */
    job.status = "scanning";
    job.message = `Calculating total rows across ${tables.length} tables...`;
    logLine(job.message);

    for (const { t: table } of tables) {
      const [[{ c }]] = await withRetry(
        () => src.query(`SELECT COUNT(*) AS c FROM \`${table}\``),
        `count ${table}`
      );
      job.tableRowPlan[table] = c;
      job.totalRowsPlanned += c;
    }
    logLine(`Scan complete: ${job.totalRowsPlanned} rows planned across ${tables.length} tables.`);

    job.status = "running";
    job.message = "Starting copy...";

    for (const { t: table } of tables) {
      job.currentTable = table;
      job.message = `Copying table: ${table}`;
      logLine(job.message);

      try {
        await withRetry(() => tgt.query(`DROP TABLE IF EXISTS \`${table}\``), `drop ${table}`);
        const [createRows] = await withRetry(() => src.query(`SHOW CREATE TABLE \`${table}\``), `show create ${table}`);
        await withRetry(() => tgt.query(createRows[0]["Create Table"]), `create ${table}`);

        /* Generated/virtual columns (STORED or VIRTUAL GENERATED ALWAYS AS)
           can't be written to directly — MySQL computes them itself. If we
           include one in the INSERT column list, every insert into that
           table fails. Find and exclude them up front. */
        const [genColRows] = await src.query(
          `SELECT COLUMN_NAME FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
             AND GENERATION_EXPRESSION IS NOT NULL AND GENERATION_EXPRESSION != ''`,
          [table]
        );
        const generatedCols = new Set(genColRows.map(r => r.COLUMN_NAME));
        if (generatedCols.size) {
          logLine(`  (skipping generated column(s) on ${table}: ${[...generatedCols].join(", ")})`);
        }

        /* Order by primary key so OFFSET pagination is stable even while
           the source table keeps getting new rows written to it mid-scan.
           Without this, rows can shift position between pages and get
           re-fetched (duplicate-key errors) or skipped entirely. */
        const pkCols = await getPrimaryKeyCols(src, table);
        const orderClause = pkCols.length
          ? `ORDER BY ${pkCols.map(c => `\`${c}\``).join(", ")}`
          : "";
        if (!pkCols.length) {
          logLine(`  (no PRIMARY KEY found on ${table} — pagination may be unstable if this table is written to during the migration)`);
        }

        const rowsPlanned = job.tableRowPlan[table] || 0;
        let batchSize = 500;
        let offset = 0;
        let tableRows = 0;
        let tableSkipped = 0;

        while (offset < rowsPlanned) {
          const take = Math.min(batchSize, rowsPlanned - offset);
          const [rows] = await withRetry(
            () => src.query(`SELECT * FROM \`${table}\` ${orderClause} LIMIT ${take} OFFSET ${offset}`),
            `select ${table} offset ${offset}`
          );
          if (!rows.length) break; // fewer rows now than at scan time (deletes) — nothing more to copy

          const cols = Object.keys(rows[0]).filter(c => !generatedCols.has(c));

          try {
            await tgt.query(buildInsertSql(table, cols, rows, tgt));
            offset += rows.length;
            tableRows += rows.length;
            job.rowsCopied += rows.length;
          } catch (batchErr) {
            /* Whole-batch insert failed — something in this chunk is
               malformed (bad JSON, oversized packet, weird encoding,
               a type MySQL won't coerce, etc). Don't lose the whole
               batch: shrink it and retry, or once we're down to single
               rows, insert one at a time and just skip+log the specific
               row(s) that actually fail instead of the whole table. */
            if (batchSize > 25) {
              batchSize = Math.max(25, Math.floor(batchSize / 5));
              logLine(`  (batch failed on ${table} at offset ${offset}: ${batchErr.message} — shrinking batch to ${batchSize} and retrying)`);
              continue; // retry same offset, smaller batch
            }

            logLine(`  (small batch still failing on ${table} at offset ${offset}: ${batchErr.message} — inserting row-by-row to isolate bad row(s))`);
            for (const row of rows) {
              try {
                await tgt.query(buildInsertSql(table, cols, [row], tgt));
                tableRows++;
                job.rowsCopied++;
              } catch (rowErr) {
                tableSkipped++;
                job.rowsSkipped++;
                const idHint = row.id !== undefined ? `id=${row.id}` : `offset ${offset}`;
                logLine(`  ⚠ skipped 1 unmigratable row in ${table} (${idHint}): ${rowErr.message}`);
              }
            }
            offset += rows.length;
          }

          updateEta();
          if (rows.length < take) break; // fewer rows now than planned (deletes) — table exhausted
        }

        logLine(`  → ${table}: ${tableRows} rows copied${tableSkipped ? `, ${tableSkipped} skipped` : ""}.`);
      } catch (tableErr) {
        /* Something failed at the table level itself (schema creation,
           listing columns, etc) rather than a specific row — log it,
           mark this table as failed, and move on to the rest instead
           of aborting the entire migration over one bad table. */
        job.failedTables.push(table);
        logLine(`  ✗ FAILED table ${table}: ${tableErr.message} — continuing with remaining tables.`);
      }

      job.tablesDone++;
    }

    await tgt.query("SET FOREIGN_KEY_CHECKS=1");

    if (job.failedTables.length) {
      job.status = "success-with-errors";
      job.message = `Migration finished with issues — ${job.tablesDone - job.failedTables.length}/${job.tablesTotal} tables fully copied, ${job.rowsCopied} rows copied, ${job.rowsSkipped} rows skipped. Failed tables: ${job.failedTables.join(", ")}`;
    } else {
      job.status = "success";
      job.message = `Migration complete — ${job.tablesDone} tables, ${job.rowsCopied} rows copied${job.rowsSkipped ? `, ${job.rowsSkipped} rows skipped` : ""}.`;
    }
    job.finishedAt = new Date().toISOString();
    logLine(job.message);
    logLine("You can now shut down / delete this throwaway service.");
  } catch (e) {
    job.status = "error";
    job.message = "Migration failed: " + e.message;
    job.finishedAt = new Date().toISOString();
    logLine("ERROR: " + e.message);
  } finally {
    if (src) await src.end();
    if (tgt) await tgt.end();
  }
}
