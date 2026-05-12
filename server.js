/**
 * Tote Scanner — Backend Server v2
 * Stack : Node.js + Express + Neon PostgreSQL + Nodemailer
 * Deploy: Render → https://tote-scanner-1.onrender.com
 */

require("dotenv").config();
const express    = require("express");
const { Pool }   = require("pg");
const nodemailer = require("nodemailer");
const cors       = require("cors");
const path       = require("path");

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ────────────────────────────────────────────
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "2mb" }));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "tote_scanner_mobile.html"));
});

// ── Neon PostgreSQL pool ──────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});
pool.on("error", (err) => console.error("[DB] Pool error:", err.message));

// ── Email transporter (created ONCE at startup) ───────────
// FIX: was created inside the function — now module-level so
//      missing env vars are caught immediately in Render logs.
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || "smtp.gmail.com",
  port:   parseInt(process.env.SMTP_PORT  || "587"),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Verify SMTP credentials on startup — shows clearly in Render logs
async function verifySmtp() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn("[EMAIL] ⚠ SMTP_USER or SMTP_PASS not set — emails will NOT be sent.");
    return;
  }
  if (!process.env.ADMIN_EMAIL) {
    console.warn("[EMAIL] ⚠ ADMIN_EMAIL not set — alerts have no destination.");
    return;
  }
  try {
    await transporter.verify();
    console.log(`[EMAIL] ✓ SMTP verified  →  alerts will go to ${process.env.ADMIN_EMAIL}`);
  } catch (err) {
    console.error("[EMAIL] ✗ SMTP verify FAILED:", err.message);
    console.error("[EMAIL]   Check SMTP_USER / SMTP_PASS in Render env vars.");
    console.error("[EMAIL]   Gmail: use an App Password, NOT your account password.");
    console.error("[EMAIL]   App Password guide → https://myaccount.google.com/apppasswords");
  }
}

// ── Send missed-totes alert ───────────────────────────────
async function sendMissedAlert(job, mode, missedTotes) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS || !process.env.ADMIN_EMAIL) {
    console.warn("[EMAIL] Skipped — SMTP not fully configured.");
    return;
  }

  const modeLabel = mode === "load" ? "Loading" : "Offloading";
  const dateStr   = new Date().toLocaleString("en-GB", { dateStyle: "full", timeStyle: "short" });

  // Group missed totes by store
  const byStore = {};
  missedTotes.forEach((t) => {
    if (!byStore[t.storeId]) byStore[t.storeId] = [];
    byStore[t.storeId].push(t.toteId);
  });

  const storeRows = Object.entries(byStore).map(([store, totes]) => `
    <tr>
      <td style="padding:10px 14px;border-bottom:1px solid #e5e7eb;font-weight:600;color:#111">${store}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #e5e7eb;color:#374151">${totes.join(" &nbsp;·&nbsp; ")}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #e5e7eb;color:#6b7280;text-align:right">${totes.length}</td>
    </tr>`).join("");

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f3f4f6;font-family:sans-serif">
<div style="max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)">
  <div style="background:#0D1B4B;padding:24px 28px">
    <h2 style="margin:0;color:#00C9A7;font-size:18px;letter-spacing:1px">⚠️ MISSED TOTES ALERT</h2>
    <p style="margin:4px 0 0;color:#7b93c0;font-size:13px">${modeLabel} session completed with exceptions</p>
  </div>
  <div style="padding:24px 28px">
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;font-size:14px">
      <tr><td style="padding:6px 0;color:#6b7280;width:140px">Manifest No.</td>
          <td style="font-weight:700;color:#111;font-size:16px">${job.manifest_no}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280">Date &amp; Time</td>
          <td style="color:#111">${dateStr}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280">Operation</td>
          <td style="color:#111">${modeLabel}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280">Total Missed</td>
          <td style="font-weight:700;color:#ef4444;font-size:15px">${missedTotes.length} tote(s)</td></tr>
    </table>
    <h3 style="margin:0 0 10px;font-size:13px;color:#374151;text-transform:uppercase;letter-spacing:1px">Missed Totes by Store</h3>
    <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;font-size:14px">
      <thead><tr style="background:#f9fafb">
        <th style="padding:10px 14px;text-align:left;color:#374151;border-bottom:1px solid #e5e7eb">Store</th>
        <th style="padding:10px 14px;text-align:left;color:#374151;border-bottom:1px solid #e5e7eb">Tote IDs</th>
        <th style="padding:10px 14px;text-align:right;color:#374151;border-bottom:1px solid #e5e7eb">Count</th>
      </tr></thead>
      <tbody>${storeRows}</tbody>
    </table>
  </div>
  <div style="background:#f9fafb;padding:14px 28px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af">
    Sent automatically by Tote Scanner · Job #${job.id}
  </div>
</div></body></html>`;

  try {
    const info = await transporter.sendMail({
      from:    `"Tote Scanner" <${process.env.SMTP_USER}>`,
      to:      process.env.ADMIN_EMAIL,
      subject: `[Alert] Missed Totes – ${job.manifest_no} – ${modeLabel}`,
      html,
    });
    console.log(`[EMAIL] ✓ Alert sent → ${process.env.ADMIN_EMAIL}  (messageId: ${info.messageId})`);
  } catch (err) {
    console.error("[EMAIL] ✗ sendMail FAILED:", err.message);
    // Common causes logged clearly:
    if (err.message.includes("535") || err.message.includes("Username and Password")) {
      console.error("[EMAIL]   → Wrong password. Gmail requires an App Password, not your account password.");
      console.error("[EMAIL]   → Create one at: https://myaccount.google.com/apppasswords");
    }
    if (err.message.includes("ECONNREFUSED") || err.message.includes("ETIMEDOUT")) {
      console.error("[EMAIL]   → Cannot reach SMTP server. Check SMTP_HOST / SMTP_PORT.");
    }
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

// Health check
app.get("/health", (_req, res) =>
  res.json({
    status:      "ok",
    ts:          new Date().toISOString(),
    db:          !!process.env.DATABASE_URL,
    smtp_user:   !!process.env.SMTP_USER,
    smtp_pass:   !!process.env.SMTP_PASS,
    admin_email: process.env.ADMIN_EMAIL || "NOT SET",
  })
);

// ── TEST EMAIL (GET /api/test-email) ──────────────────────
// Open in browser to verify SMTP works without pressing Complete.
// e.g. https://tote-scanner-1.onrender.com/api/test-email
app.get("/api/test-email", async (_req, res) => {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS || !process.env.ADMIN_EMAIL) {
    return res.json({
      success: false,
      error:   "Missing env vars",
      missing: {
        SMTP_USER:   !process.env.SMTP_USER,
        SMTP_PASS:   !process.env.SMTP_PASS,
        ADMIN_EMAIL: !process.env.ADMIN_EMAIL,
      },
    });
  }
  try {
    const info = await transporter.sendMail({
      from:    `"Tote Scanner Test" <${process.env.SMTP_USER}>`,
      to:      process.env.ADMIN_EMAIL,
      subject: "[Tote Scanner] Test Email — SMTP is working ✓",
      html:    `<p style="font-family:sans-serif">This is a test email from your Tote Scanner server.<br>If you received this, email alerts are working correctly.</p>`,
    });
    console.log(`[EMAIL] ✓ Test email sent → ${process.env.ADMIN_EMAIL}`);
    res.json({ success: true, messageId: info.messageId, to: process.env.ADMIN_EMAIL });
  } catch (err) {
    console.error("[EMAIL] ✗ Test email FAILED:", err.message);
    res.json({ success: false, error: err.message });
  }
});

// ── POST /api/jobs ────────────────────────────────────────
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
      const params = [jobId, ...chunk.flatMap(t => [t.toteId, t.storeId||""])];
      await client.query(`INSERT INTO totes(job_id,tote_id,store_id) VALUES ${vals}`, params);
    }

    await client.query("COMMIT");
    console.log(`[DB] Job #${jobId} created — manifest: ${manifest_no}, totes: ${totes.length}`);
    res.json({ id: jobId, manifest_no, total_totes: totes.length });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[POST /api/jobs]", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── GET /api/jobs ─────────────────────────────────────────
app.get("/api/jobs", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM jobs ORDER BY created_at DESC LIMIT 200`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/jobs/:id ─────────────────────────────────────
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

// ── POST /api/jobs/:id/complete/:mode ─────────────────────
app.post("/api/jobs/:id/complete/:mode", async (req, res) => {
  const { id, mode } = req.params;
  if (!["load","offload"].includes(mode))
    return res.status(400).json({ error: "mode must be load or offload" });

  const { scanned = [], missed = [] } = req.body;
  console.log(`[COMPLETE] Job #${id} · mode=${mode} · scanned=${scanned.length} · missed=${missed.length}`);

  const client = await pool.connect();
  try {
    const jobRes = await client.query("SELECT * FROM jobs WHERE id=$1", [id]);
    if (!jobRes.rows.length) return res.status(404).json({ error: "Job not found" });
    const job = jobRes.rows[0];

    await client.query("BEGIN");

    // Batch insert scan records
    for (let i = 0; i < scanned.length; i += 100) {
      const chunk  = scanned.slice(i, i + 100);
      const vals   = chunk.map((_,j) => `($1,$2,$${j*2+3},$${j*2+4})`).join(",");
      const params = [id, mode, ...chunk.flatMap(t => [t.toteId, t.storeId||""])];
      await client.query(`INSERT INTO scan_records(job_id,mode,tote_id,store_id) VALUES ${vals}`, params);
    }

    // Batch insert missed records
    for (let i = 0; i < missed.length; i += 100) {
      const chunk  = missed.slice(i, i + 100);
      const vals   = chunk.map((_,j) => `($1,$2,$${j*2+3},$${j*2+4})`).join(",");
      const params = [id, mode, ...chunk.flatMap(t => [t.toteId, t.storeId||""])];
      await client.query(`INSERT INTO missed_records(job_id,mode,tote_id,store_id) VALUES ${vals}`, params);
    }

    const otherDone = mode==="load" ? !!job.offload_completed_at : !!job.load_completed_at;
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
    console.log(`[DB] Job #${id} ${mode} complete — status: ${status}`);

    // Send email alert for missed totes
    if (missed.length > 0) {
      console.log(`[EMAIL] Sending missed-tote alert for ${missed.length} tote(s)...`);
      sendMissedAlert(job, mode, missed).catch(e => console.error("[EMAIL] Async error:", e.message));
    } else {
      console.log("[EMAIL] No missed totes — alert not needed.");
    }

    res.json({ success: true, scanned: scanned.length, missed: missed.length, status });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`[POST /api/jobs/${id}/complete/${mode}]`, err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── Boot ──────────────────────────────────────────────────
initDB()
  .then(() => verifySmtp())
  .then(() =>
    app.listen(PORT, () => {
      console.log(`\n⬡  Tote Scanner →  http://localhost:${PORT}`);
      console.log(`   DATABASE_URL : ${process.env.DATABASE_URL ? "✓ set" : "✗ NOT SET"}`);
      console.log(`   SMTP_USER    : ${process.env.SMTP_USER    || "✗ NOT SET"}`);
      console.log(`   ADMIN_EMAIL  : ${process.env.ADMIN_EMAIL  || "✗ NOT SET"}\n`);
    })
  )
  .catch((err) => {
    console.error("[FATAL]", err.message);
    process.exit(1);
  });
