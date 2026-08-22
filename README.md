# DB Migrator (standalone, throwaway)

Copies every table (schema + data) from your OLD database straight into
your NEW database, server-to-server on Railway. Your phone never carries
the data — it's just used to check progress in a browser.

This is a completely separate project. It does not touch your existing
IntelSeller code at all.

## Deploy steps (from your phone, via Railway's website)

1. Go to Railway → **New Project** → **Deploy from GitHub repo** (or
   **Empty Project** → then drag/upload this folder if you prefer not
   to use GitHub — either works).
2. Once the service exists, open its **Variables** tab and add:
   - `OLD_MYSQL_URL` = the full connection string of your OLD database
     (the one with your real data — same `mysql://user:pass@host:port/db`
     format you'd use to connect to it directly)
   - `NEW_MYSQL_URL` = `mysql://root:JvyzsUVWfwypWyYjOQYAXbVjpztDzEdy@altaria.proxy.rlwy.net:31283/railway`
   - *(optional)* `MIGRATION_ACCESS_KEY` = any password you make up, to
     stop random people from viewing the status page/logs while this is
     public. If you skip this, the status page is open to anyone with
     the URL, which is fine for a short-lived throwaway service.
3. Deploy. Railway will build it automatically (it just needs
   `npm install` then `npm start` — already configured).
4. Once it's live, open the service's public URL from your phone
   (Settings → Networking → Generate Domain, if it doesn't have one yet).
   You'll see a live status page: current table, rows copied, progress
   bar, and a running log — auto-refreshing every few seconds.
5. When it says **"Migration complete"**, your NEW database has
   everything. You can then delete this whole throwaway project.

## Notes

- ⚠️ This **overwrites** every table in the NEW database that also
  exists in the OLD one (drops and recreates it). Only point
  `NEW_MYSQL_URL` at a database you're fine with being fully replaced.
- If it fails partway, the status page will show the exact error —
  fix whatever it points to (usually a connection issue) and redeploy;
  it starts fresh each run.
- Safe to leave your phone screen off / app closed once this is
  running — it's a server-side background process independent of your
  phone.
