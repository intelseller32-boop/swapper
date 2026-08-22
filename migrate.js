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
  status: "idle",       // idle | missing-config | running | success | error
  message: "Starting up...",
  tablesTotal: 0,
  tablesDone: 0,
  currentTable: null,
  rowsCopied: 0,
  startedAt: null,
  finishedAt: null,
  log: []
};

function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  job.log.push(line);
  if (job.log.length > 300) job.log.shift(); // keep it bounded
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
  <p>${job.message}</p>
  <div class="bar-bg"><div class="bar" style="width:${job.tablesTotal ? Math.round(job.tablesDone / job.tablesTotal * 100) : 0}%"></div></div>
  <p>Tables: ${job.tablesDone} / ${job.tablesTotal} &nbsp; | &nbsp; Rows copied so far: ${job.rowsCopied}</p>
  <p>Current table: ${job.currentTable || "-"}</p>
  <p>Started: ${job.startedAt || "-"} &nbsp; Finished: ${job.finishedAt || "-"}</p>
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
    src = await mysql.createConnection({ uri: OLD_MYSQL_URL, timezone: "+00:00" });
    tgt = await mysql.createConnection({ uri: NEW_MYSQL_URL, timezone: "+00:00" });
    logLine("Connected to source and target databases.");

    await tgt.query("SET FOREIGN_KEY_CHECKS=0");

    const [tables] = await src.query(
      "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name"
    );
    job.tablesTotal = tables.length;
    logLine(`Found ${tables.length} tables to migrate.`);

    for (const { t: table } of tables) {
      job.currentTable = table;
      job.message = `Copying table: ${table}`;
      logLine(job.message);

      await tgt.query(`DROP TABLE IF EXISTS \`${table}\``);
      const [createRows] = await src.query(`SHOW CREATE TABLE \`${table}\``);
      await tgt.query(createRows[0]["Create Table"]);

      const BATCH = 500;
      let offset = 0;
      let tableRows = 0;
      while (true) {
        const [rows] = await src.query(`SELECT * FROM \`${table}\` LIMIT ${BATCH} OFFSET ${offset}`);
        if (!rows.length) break;

        const cols = Object.keys(rows[0]);
        const colList = cols.map(c => `\`${c}\``).join(", ");
        const valueLines = rows.map(r => "(" + cols.map(c => tgt.escape(r[c])).join(", ") + ")");
        await tgt.query(`INSERT INTO \`${table}\` (${colList}) VALUES ${valueLines.join(",")}`);

        offset += rows.length;
        tableRows += rows.length;
        job.rowsCopied += rows.length;
        if (rows.length < BATCH) break;
      }

      logLine(`  → ${table}: ${tableRows} rows copied.`);
      job.tablesDone++;
    }

    await tgt.query("SET FOREIGN_KEY_CHECKS=1");

    job.status = "success";
    job.message = `Migration complete — ${job.tablesDone} tables, ${job.rowsCopied} rows copied.`;
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
