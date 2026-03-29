/**
 * Tote Scanner — Backend Server (Neon DB / PostgreSQL Version)
 * Stack: Node.js + Express + pg (PostgreSQL) + Nodemailer
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
app.use(cors());
app.use(express.json());

// Serve the mobile HTML from the same folder
app.use(express.static(__dirname));

// 주소만 입력했을 때( / ) 자동으로 HTML 파일을 보여줌
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "tote_scanner_mobile.html"));
});

// ── Database setup (Neon DB / PostgreSQL) ──────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Initialize Tables for PostgreSQL
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS jobs (
        id                   SERIAL PRIMARY KEY,
        manifest_no          TEXT    NOT NULL,
        label                TEXT,
        created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        total_totes          INTEGER DEFAULT 0,
        load_completed_at    TIMESTAMP,
        load_scanned         INTEGER DEFAULT 0,
        load_missed          INTEGER DEFAULT 0,
        offload_completed_at TIMESTAMP,
        offload_scanned      INTEGER DEFAULT 0,
        offload_missed       INTEGER DEFAULT 0,
        status               TEXT DEFAULT 'in_progress'
      );

      CREATE TABLE IF NOT EXISTS totes (
        id        SERIAL PRIMARY KEY,
        job_id    INTEGER NOT NULL REFERENCES jobs(id),
        tote_id   TEXT    NOT NULL,
        store_id  TEXT
      );

      CREATE TABLE IF NOT EXISTS scan_records (
        id         SERIAL PRIMARY KEY,
        job_id     INTEGER NOT NULL REFERENCES jobs(id),
        mode       TEXT    NOT NULL,
        tote_id    TEXT    NOT NULL,
        store_id   TEXT,
        scanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS missed_records (
        id        SERIAL PRIMARY KEY,
        job_id    INTEGER NOT NULL REFERENCES jobs(id),
        mode      TEXT    NOT NULL,
        tote_id   TEXT    NOT NULL,
        store_id  TEXT
      );
    `);
    console.log("Database tables initialized successfully.");
  } catch (err) {
    console.error("Error initializing database:", err);
  } finally {
    client.release();
  }
}
initDB();

// ── Email ─────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || "smtp.gmail.com",
  port:   parseInt(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendMissedAlert(job, mode, missedTotes) {
  if (!process.env.ADMIN_EMAIL || !process.env.SMTP_USER) {
    console.log("[EMAIL] SMTP not configured – skipping email.");
    return;
  }

  const modeLabel = mode === "load" ? "Loading" : "Offloading";
  const byStore = {};
  missedTotes.forEach(t => {
    if (!byStore[t.storeId]) byStore[t.storeId] = [];
    byStore[t.storeId].push(t.toteId);
  });

  const storeRows = Object.entries(byStore).map(([store, totes]) => `
    <tr>
      <td style="padding:10px 14px;border-bottom:1px solid #e5e7eb;font-weight:600;color:#111">${store}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #e5e7eb;color:#374151">${totes.join("&nbsp;&nbsp;·&nbsp;&nbsp;")}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #e5e7eb;color:#6b7280;text-align:right">${totes.length}</td>
    </tr>`).join("");

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f3f4f6;font-family:sans-serif">
    <div style="max-width:600px;margin:32px auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)">
      <div style="background:#0A1628;padding:24px 28px;display:flex;align-items:center;gap:12px">
        <span style="font-size:24px">⚠️</span>
        <div>
          <h2 style="margin:0;color:#00C8F0;font-size:18px;letter-spacing:1px">MISSED TOTES ALERT</h2>
          <p style="margin:2px 0 0;color:#5A7A9A;font-size:13px">${modeLabel} session completed with exceptions</p>
        </div>
      </div>
      <div style="padding:24px 28px">
        <table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:14px">
          <tr><td style="padding:6px 0;color:#6b7280;width:140px">Manifest No.</td><td style="font-weight:700;color:#111;font-size:16px">${job.manifest_no}</td></tr>
          <tr><td style="padding:6px 0;color:#6b7280">Operation</td><td style="color:#111">${modeLabel}</td></tr>
          <tr><td style="padding:6px 0;color:#6b7280">Total Missed</td><td style="font-weight:700;color:#FF3D57;font-size:15px">${missedTotes.length} tote(s)</td></tr>
        </table>
        <h3 style="margin:0 0 10px;font-size:14px;color:#374151;text-transform:uppercase;letter-spacing:1px">Missed Totes by Store</h3>
        <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;font-size:14px">
          <thead><tr style="background:#f9fafb"><th style="padding:10px 14px;text-align:left">Store</th><th style="padding:10px 14px;text-align:left">Tote IDs</th><th style="padding:10px 14px;text-align:right">Count</th></tr></thead>
          <tbody>${storeRows}</tbody>
        </table>
      </div>
    </div></body></html>`;

  try {
    await transporter.sendMail({
      from: `"Tote Scanner" <${process.env.SMTP_USER}>`,
      to: process.env.ADMIN_EMAIL,
      subject: `[Alert] Missed Totes – Manifest ${job.manifest_no} – ${modeLabel}`,
      html,
    });
  } catch (err) {
    console.error("[EMAIL] Failed to send:", err.message);
  }
}

// ── Routes ────────────────────────────────────────────────

// POST /api/jobs — create a new job
app.post("/api/jobs", async (req, res) => {
  const { manifest_no, label, totes } = req.body;
  if (!manifest_no || !Array.isArray(totes) || !totes.length)
    return res.status(400).json({ error: "manifest_no and totes[] are required" });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const jobRes = await client.query(
      'INSERT INTO jobs (manifest_no, label, total_totes) VALUES ($1, $2, $3) RETURNING id',
      [manifest_no.trim(), label || manifest_no.trim(), totes.length]
    );
    const jobId = jobRes.rows[0].id;

    for (const t of totes) {
      await client.query(
        'INSERT INTO totes (job_id, tote_id, store_id) VALUES ($1, $2, $3)',
        [jobId, t.toteId, t.storeId || ""]
      );
    }
    await client.query('COMMIT');
    res.json({ id: jobId, manifest_no, total_totes: totes.length, status: "in_progress" });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/jobs — list all jobs
app.get("/api/jobs", async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jobs/:id — job detail
app.get("/api/jobs/:id", async (req, res) => {
  try {
    const jobRes = await pool.query('SELECT * FROM jobs WHERE id = $1', [req.params.id]);
    if (jobRes.rows.length === 0) return res.status(404).json({ error: "Job not found" });
    const job = jobRes.rows[0];
    const totesRes = await pool.query('SELECT * FROM totes WHERE job_id = $1 ORDER BY tote_id', [job.id]);
    const missedRes = await pool.query('SELECT * FROM missed_records WHERE job_id = $1 ORDER BY mode, store_id, tote_id', [job.id]);
    res.json({ ...job, totes: totesRes.rows, missed: missedRes.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/jobs/:id/complete/:mode
app.post("/api/jobs/:id/complete/:mode", async (req, res) => {
  const { id, mode } = req.params;
  const { scanned = [], missed = [] } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const jobRes = await client.query('SELECT * FROM jobs WHERE id = $1', [id]);
    if (jobRes.rows.length === 0) throw new Error("Job not found");
    const job = jobRes.rows[0];

    for (const t of scanned) {
      await client.query('INSERT INTO scan_records (job_id, mode, tote_id, store_id) VALUES ($1, $2, $3, $4)', [id, mode, t.toteId, t.storeId || ""]);
    }
    for (const t of missed) {
      await client.query('INSERT INTO missed_records (job_id, mode, tote_id, store_id) VALUES ($1, $2, $3, $4)', [id, mode, t.toteId, t.storeId || ""]);
    }

    const otherMode = mode === "load" ? "offload" : "load";
    const otherDone = !!job[`${otherMode}_completed_at`];
    const newStatus = otherDone ? "completed" : "in_progress";

    if (mode === "load") {
      await client.query('UPDATE jobs SET load_completed_at=CURRENT_TIMESTAMP, load_scanned=$1, load_missed=$2, status=$3 WHERE id=$4', [scanned.length, missed.length, newStatus, id]);
    } else {
      await client.query('UPDATE jobs SET offload_completed_at=CURRENT_TIMESTAMP, offload_scanned=$1, offload_missed=$2, status=$3 WHERE id=$4', [scanned.length, missed.length, newStatus, id]);
    }

    await client.query('COMMIT');
    if (missed.length > 0) await sendMissedAlert(job, mode, missed);
    res.json({ success: true, status: newStatus });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
