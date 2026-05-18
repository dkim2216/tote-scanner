/**
 * Tote Scanner — Backend Server v3
 * Stack : Node.js + Express + Neon PostgreSQL + Resend + XLSX
 * Deploy: Render → https://tote-scanner-1.onrender.com
 */

require("dotenv").config();
const express  = require("express");
const { Pool } = require("pg");
const { Resend }= require("resend");
const XLSX     = require("xlsx");
const cors     = require("cors");
const path     = require("path");

const app    = express();
const PORT   = process.env.PORT || 3001;
const resend = new Resend(process.env.RESEND_API_KEY);

// ── Middleware ────────────────────────────────────────────
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, ".")));

// Serve the HTML at root "/"
app.get("/", (_req, res) =>
  res.sendFile(path.join(__dirname, "tote_scanner_mobile.html"))
);

// ── Neon PostgreSQL ───────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});
pool.on("error", (err) => console.error("[DB] Pool error:", err.message));

// ══════════════════════════════════════════════════════════
//  EXCEL GENERATOR
// ══════════════════════════════════════════════════════════
function generateExcel(job, mode, scannedTotes, missedTotes) {
  const modeLabel = mode === "load" ? "Loading" : "Offloading";
  const dateStr   = new Date().toLocaleDateString("en-GB", { day:"2-digit", month:"short", year:"numeric" });
  const wb        = XLSX.utils.book_new();

  // ── Sheet 1: Summary ─────────────────────────────────
  const allStores = [...new Set([...scannedTotes, ...missedTotes].map(t => t.storeId))].sort();

  const summaryRows = [
    // Title block
    [`Tote Scanner — ${modeLabel} Report`],
    [`Manifest: ${job.manifest_no}`],
    [`Date: ${dateStr}`],
    [`Job ID: #${job.id}`],
    [],
    // Per-store summary table
    ["Store", "Total Totes", "Scanned", "Missing", "Status"],
    ...allStores.map(store => {
      const sc = scannedTotes.filter(t => t.storeId === store).length;
      const ms = missedTotes.filter(t => t.storeId === store).length;
      return [store, sc + ms, sc, ms, ms === 0 ? "✓ Complete" : `✗ ${ms} Missing`];
    }),
    [],
    // Totals row
    ["TOTAL", scannedTotes.length + missedTotes.length, scannedTotes.length, missedTotes.length,
     missedTotes.length === 0 ? "✓ All Clear" : `✗ ${missedTotes.length} Missing`],
  ];

  const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);

  // Column widths for summary
  wsSummary["!cols"] = [
    { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 18 },
  ];

  XLSX.utils.book_append_sheet(wb, wsSummary, "Summary");

  // ── Sheet 2: All Totes (flat list) ────────────────────
  const allRows = [
    ["Store", "Tote ID", "Status"],
    // Scanned first, sorted by store then tote
    ...[...scannedTotes]
      .sort((a, b) => a.storeId.localeCompare(b.storeId) || a.toteId.localeCompare(b.toteId))
      .map(t => [t.storeId, t.toteId, "SCANNED"]),
    // Missing next
    ...[...missedTotes]
      .sort((a, b) => a.storeId.localeCompare(b.storeId) || a.toteId.localeCompare(b.toteId))
      .map(t => [t.storeId, t.toteId, "MISSING"]),
  ];

  const wsAll = XLSX.utils.aoa_to_sheet(allRows);
  wsAll["!cols"] = [{ wch: 18 }, { wch: 16 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, wsAll, "All Totes");

  // ── Sheet 3+: One sheet per store ────────────────────
  allStores.forEach(store => {
    const storeScanned = scannedTotes
      .filter(t => t.storeId === store)
      .sort((a, b) => a.toteId.localeCompare(b.toteId));
    const storeMissed  = missedTotes
      .filter(t => t.storeId === store)
      .sort((a, b) => a.toteId.localeCompare(b.toteId));

    const rows = [
      [`${store} — ${modeLabel} Report`],
      [`Date: ${dateStr}   |   Manifest: ${job.manifest_no}`],
      [],
      ["Tote ID", "Status"],
      // Scanned
      ...storeScanned.map(t => [t.toteId, "SCANNED"]),
      // Blank separator only if both exist
      ...(storeScanned.length > 0 && storeMissed.length > 0 ? [[]] : []),
      // Missing
      ...storeMissed.map(t => [t.toteId, "MISSING"]),
      [],
      // Footer totals
      ["Scanned",  storeScanned.length],
      ["Missing",  storeMissed.length],
      ["Total",    storeScanned.length + storeMissed.length],
    ];

    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{ wch: 18 }, { wch: 12 }];

    // Sheet name: Excel max 31 chars, strip special chars
    const sheetName = store.replace(/[\\/*?[\]:]/g, "").substring(0, 31);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  });

  // Return as base64 string for Resend attachment
  return XLSX.write(wb, { type: "base64", bookType: "xlsx" });
}

// ══════════════════════════════════════════════════════════
//  EMAIL ALERT  (Resend + XLSX attachment)
// ══════════════════════════════════════════════════════════
async function sendMissedAlert(job, mode, scannedTotes, missedTotes) {
  if (!process.env.RESEND_API_KEY || !process.env.ADMIN_EMAIL) {
    console.warn("[EMAIL] Skipped — RESEND_API_KEY or ADMIN_EMAIL not set.");
    return;
  }

  const modeLabel  = mode === "load" ? "Loading" : "Offloading";
  const dateStr    = new Date().toLocaleString("en-GB", { dateStyle: "full", timeStyle: "short" });
  const allStores  = [...new Set([...scannedTotes, ...missedTotes].map(t => t.storeId))].sort();
  const hasMissed  = missedTotes.length > 0;

  // Group missed by store for email table
  const byStore = {};
  missedTotes.forEach(t => {
    if (!byStore[t.storeId]) byStore[t.storeId] = [];
    byStore[t.storeId].push(t.toteId);
  });

  // Per-store summary rows for email
  const storeEmailRows = allStores.map(store => {
    const sc = scannedTotes.filter(t => t.storeId === store).length;
    const ms = missedTotes.filter(t => t.storeId === store).length;
    const statusColor = ms === 0 ? "#00C9A7" : "#ef4444";
    const statusText  = ms === 0 ? "✓ Complete" : `✗ ${ms} missing`;
    return `
      <tr>
        <td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;font-weight:600;color:#0D1B4B">${store}</td>
        <td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;text-align:center;color:#1e293b">${sc + ms}</td>
        <td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;text-align:center;color:#00C9A7;font-weight:600">${sc}</td>
        <td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;text-align:center;color:${ms > 0 ? "#ef4444" : "#94a3b8"};font-weight:600">${ms}</td>
        <td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;text-align:center;color:${statusColor};font-weight:700">${statusText}</td>
      </tr>`;
  }).join("");

  // Missing totes detail section (only if any missed)
  const missedDetail = hasMissed ? `
    <h3 style="margin:28px 0 12px;font-size:13px;color:#1e293b;text-transform:uppercase;letter-spacing:1px;font-family:sans-serif">
      Missing Tote Detail
    </h3>
    <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;font-size:13px">
      <thead><tr style="background:#fff5f5">
        <th style="padding:10px 14px;text-align:left;color:#ef4444;border-bottom:1px solid #fee2e2">Store</th>
        <th style="padding:10px 14px;text-align:left;color:#ef4444;border-bottom:1px solid #fee2e2">Missing Tote IDs</th>
        <th style="padding:10px 14px;text-align:right;color:#ef4444;border-bottom:1px solid #fee2e2">Count</th>
      </tr></thead>
      <tbody>
        ${Object.entries(byStore).map(([store, totes]) => `
          <tr>
            <td style="padding:10px 14px;border-bottom:1px solid #fee2e2;font-weight:600;color:#0D1B4B;vertical-align:top">${store}</td>
            <td style="padding:10px 14px;border-bottom:1px solid #fee2e2;color:#374151;font-family:monospace;font-size:12px">${totes.join("&nbsp;&nbsp;·&nbsp;&nbsp;")}</td>
            <td style="padding:10px 14px;border-bottom:1px solid #fee2e2;text-align:right;color:#ef4444;font-weight:700">${totes.length}</td>
          </tr>`).join("")}
      </tbody>
    </table>` : "";

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f8fafc;font-family:sans-serif">
<div style="max-width:640px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08)">

  <!-- Header -->
  <div style="background:#0D1B4B;padding:28px">
    <div style="display:flex;align-items:center;gap:12px">
      <span style="font-size:28px">${hasMissed ? "⚠️" : "✅"}</span>
      <div>
        <h2 style="margin:0;color:#00C9A7;font-size:18px;letter-spacing:1px;font-family:sans-serif">
          ${hasMissed ? "MISSED TOTES ALERT" : "SESSION COMPLETE"}
        </h2>
        <p style="margin:3px 0 0;color:#7b93c0;font-size:12px;font-family:sans-serif">
          ${modeLabel} · ${job.manifest_no}
        </p>
      </div>
    </div>
  </div>

  <!-- Details -->
  <div style="padding:24px 28px">
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;font-size:14px">
      <tr><td style="padding:6px 0;color:#94a3b8;width:130px">Manifest No.</td>
          <td style="font-weight:700;color:#0D1B4B;font-size:16px">${job.manifest_no}</td></tr>
      <tr><td style="padding:6px 0;color:#94a3b8">Date &amp; Time</td>
          <td style="color:#1e293b">${dateStr}</td></tr>
      <tr><td style="padding:6px 0;color:#94a3b8">Operation</td>
          <td style="color:#1e293b">${modeLabel}</td></tr>
      <tr><td style="padding:6px 0;color:#94a3b8">Total Scanned</td>
          <td style="font-weight:700;color:#00C9A7;font-size:15px">${scannedTotes.length}</td></tr>
      <tr><td style="padding:6px 0;color:#94a3b8">Total Missing</td>
          <td style="font-weight:700;color:${hasMissed ? "#ef4444" : "#94a3b8"};font-size:15px">${missedTotes.length}</td></tr>
    </table>

    <!-- Per-store summary table -->
    <h3 style="margin:0 0 12px;font-size:13px;color:#1e293b;text-transform:uppercase;letter-spacing:1px;font-family:sans-serif">
      Summary by Store
    </h3>
    <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;font-size:13px">
      <thead><tr style="background:#f8fafc">
        <th style="padding:10px 14px;text-align:left;color:#1e293b;border-bottom:1px solid #e2e8f0">Store</th>
        <th style="padding:10px 14px;text-align:center;color:#1e293b;border-bottom:1px solid #e2e8f0">Total</th>
        <th style="padding:10px 14px;text-align:center;color:#00C9A7;border-bottom:1px solid #e2e8f0">Scanned</th>
        <th style="padding:10px 14px;text-align:center;color:#ef4444;border-bottom:1px solid #e2e8f0">Missing</th>
        <th style="padding:10px 14px;text-align:center;color:#1e293b;border-bottom:1px solid #e2e8f0">Status</th>
      </tr></thead>
      <tbody>${storeEmailRows}</tbody>
      <!-- Totals row -->
      <tr style="background:#f8fafc;font-weight:700">
        <td style="padding:10px 14px;color:#0D1B4B">TOTAL</td>
        <td style="padding:10px 14px;text-align:center;color:#0D1B4B">${scannedTotes.length + missedTotes.length}</td>
        <td style="padding:10px 14px;text-align:center;color:#00C9A7">${scannedTotes.length}</td>
        <td style="padding:10px 14px;text-align:center;color:${hasMissed ? "#ef4444" : "#94a3b8"}">${missedTotes.length}</td>
        <td style="padding:10px 14px;text-align:center;color:${hasMissed ? "#ef4444" : "#00C9A7"}">${hasMissed ? `✗ ${missedTotes.length} Missing` : "✓ All Clear"}</td>
      </tr>
    </table>

    ${missedDetail}

    <!-- Excel note -->
    <div style="margin-top:24px;background:#f0fdf9;border:1px solid #00C9A730;border-radius:10px;padding:14px 16px;font-size:13px;color:#1e293b">
      📎 <strong>Excel report attached</strong> — includes a tab per store showing all scanned and missing totes.
    </div>
  </div>

  <!-- Footer -->
  <div style="background:#f8fafc;padding:14px 28px;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8;font-family:sans-serif">
    Sent automatically by Tote Scanner · Job #${job.id}
  </div>
</div></body></html>`;

  // Generate Excel
  const xlsxBase64 = generateExcel(job, mode, scannedTotes, missedTotes);
  const filename   = `tote_report_${job.manifest_no}_${mode}_${new Date().toISOString().slice(0,10)}.xlsx`;

  try {
    const result = await resend.emails.send({
      from:        process.env.RESEND_FROM || "Tote Scanner <alerts@resend.dev>",
      to:          [process.env.ADMIN_EMAIL],
      subject:     hasMissed
        ? `[Alert] Missed Totes — ${job.manifest_no} — ${modeLabel}`
        : `[Complete] ${job.manifest_no} — ${modeLabel} All Clear`,
      html,
      attachments: [
        {
          filename,
          content: xlsxBase64,   // Resend accepts base64 string
        },
      ],
    });
    console.log(`[EMAIL] ✓ Sent → ${process.env.ADMIN_EMAIL}  (id: ${result.data?.id})`);
  } catch (err) {
    console.error("[EMAIL] ✗ Failed:", err.message);
  }
}

// ══════════════════════════════════════════════════════════
//  DATABASE INIT
// ══════════════════════════════════════════════════════════
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS jobs (
        id                    SERIAL PRIMARY KEY,
        manifest_no           TEXT        NOT NULL,
        label                 TEXT,
        created_at            TIMESTAMPTZ DEFAULT NOW(),
        total_totes           INT         DEFAULT 0,
        load_completed_at     TIMESTAMPTZ,
        load_scanned          INT         DEFAULT 0,
        load_missed           INT         DEFAULT 0,
        offload_completed_at  TIMESTAMPTZ,
        offload_scanned       INT         DEFAULT 0,
        offload_missed        INT         DEFAULT 0,
        status                TEXT        DEFAULT 'in_progress'
      );
      CREATE TABLE IF NOT EXISTS totes (
        id       SERIAL PRIMARY KEY,
        job_id   INT  NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        tote_id  TEXT NOT NULL,
        store_id TEXT
      );
      CREATE TABLE IF NOT EXISTS scan_records (
        id         SERIAL PRIMARY KEY,
        job_id     INT  NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        mode       TEXT NOT NULL,
        tote_id    TEXT NOT NULL,
        store_id   TEXT,
        scanned_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS missed_records (
        id        SERIAL PRIMARY KEY,
        job_id    INT  NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        mode      TEXT NOT NULL,
        tote_id   TEXT NOT NULL,
        store_id  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_totes_job      ON totes(job_id);
      CREATE INDEX IF NOT EXISTS idx_scans_job_mode ON scan_records(job_id, mode);
      CREATE INDEX IF NOT EXISTS idx_missed_job     ON missed_records(job_id);
    `);
    console.log("[DB] ✓ Schema ready");
  } finally {
    client.release();
  }
}

// ══════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════

app.get("/health", (_req, res) => res.json({
  status:      "ok",
  ts:          new Date().toISOString(),
  db:          !!process.env.DATABASE_URL,
  resend:      !!process.env.RESEND_API_KEY,
  admin_email: process.env.ADMIN_EMAIL || "NOT SET",
}));

// Test email endpoint
app.get("/api/test-email", async (_req, res) => {
  if (!process.env.RESEND_API_KEY || !process.env.ADMIN_EMAIL) {
    return res.json({ success: false, missing: { RESEND_API_KEY: !process.env.RESEND_API_KEY, ADMIN_EMAIL: !process.env.ADMIN_EMAIL } });
  }
  try {
    // Send a test email with a dummy Excel attachment
    const dummyJob     = { id: 0, manifest_no: "TEST-001" };
    const dummyScanned = [{ toteId: "TOTE-001", storeId: "Store A" }, { toteId: "TOTE-002", storeId: "Store B" }];
    const dummyMissed  = [{ toteId: "TOTE-003", storeId: "Store A" }];
    await sendMissedAlert(dummyJob, "load", dummyScanned, dummyMissed);
    res.json({ success: true, to: process.env.ADMIN_EMAIL });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// POST /api/jobs
app.post("/api/jobs", async (req, res) => {
  const { manifest_no, label, totes } = req.body;
  if (!manifest_no || !Array.isArray(totes) || !totes.length)
    return res.status(400).json({ error: "manifest_no and totes[] required" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO jobs (manifest_no, label, total_totes) VALUES ($1,$2,$3) RETURNING id`,
      [manifest_no.trim(), label || manifest_no.trim(), totes.length]
    );
    const jobId = rows[0].id;
    for (let i = 0; i < totes.length; i += 100) {
      const chunk  = totes.slice(i, i + 100);
      const vals   = chunk.map((_,j) => `($1,$${j*2+2},$${j*2+3})`).join(",");
      const params = [jobId, ...chunk.flatMap(t => [t.toteId, t.storeId || ""])];
      await client.query(`INSERT INTO totes(job_id,tote_id,store_id) VALUES ${vals}`, params);
    }
    await client.query("COMMIT");
    console.log(`[DB] Job #${jobId} created — ${manifest_no}, ${totes.length} totes`);
    res.json({ id: jobId, manifest_no, total_totes: totes.length });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/jobs
app.get("/api/jobs", async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT 200`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jobs/:id
app.get("/api/jobs/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const job    = await client.query("SELECT * FROM jobs WHERE id=$1", [req.params.id]);
    if (!job.rows.length) return res.status(404).json({ error: "Not found" });
    const missed = await client.query(
      "SELECT * FROM missed_records WHERE job_id=$1 ORDER BY mode,store_id,tote_id", [req.params.id]);
    res.json({ ...job.rows[0], missed: missed.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/jobs/:id/complete/:mode
app.post("/api/jobs/:id/complete/:mode", async (req, res) => {
  const { id, mode } = req.params;
  if (!["load","offload"].includes(mode))
    return res.status(400).json({ error: "mode must be load or offload" });

  const { scanned = [], missed = [] } = req.body;
  console.log(`[COMPLETE] Job #${id} · ${mode} · scanned=${scanned.length} · missed=${missed.length}`);

  const client = await pool.connect();
  try {
    const jobRes = await client.query("SELECT * FROM jobs WHERE id=$1", [id]);
    if (!jobRes.rows.length) return res.status(404).json({ error: "Job not found" });
    const job = jobRes.rows[0];

    await client.query("BEGIN");

    for (let i = 0; i < scanned.length; i += 100) {
      const chunk  = scanned.slice(i, i + 100);
      const vals   = chunk.map((_,j) => `($1,$2,$${j*2+3},$${j*2+4})`).join(",");
      const params = [id, mode, ...chunk.flatMap(t => [t.toteId, t.storeId || ""])];
      await client.query(`INSERT INTO scan_records(job_id,mode,tote_id,store_id) VALUES ${vals}`, params);
    }
    for (let i = 0; i < missed.length; i += 100) {
      const chunk  = missed.slice(i, i + 100);
      const vals   = chunk.map((_,j) => `($1,$2,$${j*2+3},$${j*2+4})`).join(",");
      const params = [id, mode, ...chunk.flatMap(t => [t.toteId, t.storeId || ""])];
      await client.query(`INSERT INTO missed_records(job_id,mode,tote_id,store_id) VALUES ${vals}`, params);
    }

    const otherDone = mode === "load" ? !!job.offload_completed_at : !!job.load_completed_at;
    const status    = otherDone ? "completed" : "in_progress";

    if (mode === "load") {
      await client.query(
        `UPDATE jobs SET load_completed_at=NOW(),load_scanned=$1,load_missed=$2,status=$3 WHERE id=$4`,
        [scanned.length, missed.length, status, id]
      );
    } else {
      await client.query(
        `UPDATE jobs SET offload_completed_at=NOW(),offload_scanned=$1,offload_missed=$2,status=$3 WHERE id=$4`,
        [scanned.length, missed.length, status, id]
      );
    }

    await client.query("COMMIT");

    // Send email with Excel attachment (always — even if no missed totes)
    sendMissedAlert(job, mode, scanned, missed)
      .catch(e => console.error("[EMAIL] Async error:", e.message));

    res.json({ success: true, scanned: scanned.length, missed: missed.length, status });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`[COMPLETE error]`, err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── Boot ──────────────────────────────────────────────────
initDB().then(() =>
  app.listen(PORT, () => {
    console.log(`\n⬡  Tote Scanner  →  http://localhost:${PORT}`);
    console.log(`   DATABASE_URL   : ${process.env.DATABASE_URL  ? "✓ set" : "✗ NOT SET"}`);
    console.log(`   RESEND_API_KEY : ${process.env.RESEND_API_KEY ? "✓ set" : "✗ NOT SET"}`);
    console.log(`   ADMIN_EMAIL    : ${process.env.ADMIN_EMAIL   || "✗ NOT SET"}`);
    console.log(`   RESEND_FROM    : ${process.env.RESEND_FROM   || "(using default)"}\n`);
  })
).catch(err => { console.error("[FATAL]", err.message); process.exit(1); });