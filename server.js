const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const path = require("path");
const nodemailer = require("nodemailer");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// Neon DB 연결 설정 (SSL 필수)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 이메일 전송 설정
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: process.env.SMTP_PORT || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// DB 테이블 강제 생성 및 연결 확인
const initDB = async () => {
  console.log("--- NEON DB CONNECTION CHECK ---");
  try {
    const client = await pool.connect();
    console.log("✅ Successfully connected to Neon DB!");
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS jobs (
        id SERIAL PRIMARY KEY,
        manifest_no TEXT,
        label TEXT,
        total_totes INTEGER,
        load_scanned INTEGER DEFAULT 0,
        load_missed INTEGER DEFAULT 0,
        offload_scanned INTEGER DEFAULT 0,
        offload_missed INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        load_completed_at TIMESTAMP,
        offload_completed_at TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS scan_records (
        id SERIAL PRIMARY KEY,
        job_id INTEGER REFERENCES jobs(id),
        mode TEXT,
        tote_id TEXT,
        store_id TEXT,
        scanned_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS missed_records (
        id SERIAL PRIMARY KEY,
        job_id INTEGER REFERENCES jobs(id),
        mode TEXT,
        tote_id TEXT,
        store_id TEXT
      );
    `);
    console.log("✅ DB Tables are ready and verified.");
    client.release();
  } catch (err) {
    console.error("❌ DB Connection/Init Error:", err.message);
    console.error("Check your DATABASE_URL environment variable in Render.");
  }
};
initDB();

app.get("/api/jobs", async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 50');
    res.json(result.rows);
  } catch (err) { 
    console.error("GET /api/jobs Error:", err.message);
    res.status(500).json([]); 
  }
});

app.post("/api/jobs", async (req, res) => {
  const { manifest_no, label, totes } = req.body;
  try {
    const jobRes = await pool.query(
      'INSERT INTO jobs (manifest_no, label, total_totes) VALUES ($1, $2, $3) RETURNING id',
      [manifest_no, label, totes.length]
    );
    console.log(`✅ New Job Created: ID ${jobRes.rows[0].id}`);
    res.json({ id: jobRes.rows[0].id });
  } catch (err) { 
    console.error("POST /api/jobs Error:", err.message);
    res.status(500).json({ error: err.message }); 
  }
});

app.post("/api/jobs/:id/complete/:mode", async (req, res) => {
  const { id, mode } = req.params;
  const { scanned = [], missed = [] } = req.body;
  try {
    if (mode === "load") {
      await pool.query('UPDATE jobs SET load_completed_at=NOW(), load_scanned=$1, load_missed=$2 WHERE id=$3', [scanned.length, missed.length, id]);
    } else {
      await pool.query('UPDATE jobs SET offload_completed_at=NOW(), offload_scanned=$1, offload_missed=$2 WHERE id=$3', [scanned.length, missed.length, id]);
    }

    for (const t of scanned) {
      await pool.query('INSERT INTO scan_records (job_id, mode, tote_id, store_id) VALUES ($1, $2, $3, $4)', [id, mode, t.toteId, t.storeId]);
    }
    for (const t of missed) {
      await pool.query('INSERT INTO missed_records (job_id, mode, tote_id, store_id) VALUES ($1, $2, $3, $4)', [id, mode, t.toteId, t.storeId]);
    }

    console.log(`✅ Job ${id} (${mode}) saved to Neon DB.`);

    // 이메일 발송
    if (process.env.SMTP_USER && process.env.SMTP_PASS && process.env.ADMIN_EMAIL) {
      const mailOptions = {
        from: `"Tote Scanner" <${process.env.SMTP_USER}>`,
        to: process.env.ADMIN_EMAIL,
        subject: `[Tote Scanner] ${mode.toUpperCase()} Complete - Job #${id}`,
        html: `<h2>Operation Complete: ${mode.toUpperCase()}</h2><p><b>Job ID:</b> ${id}</p><p><b>Scanned:</b> ${scanned.length}</p><p><b>Missed:</b> ${missed.length}</p><hr/><h3>Missed Totes:</h3><ul>${missed.map(m => `<li>${m.toteId} (Store: ${m.storeId})</li>`).join('')}</ul>`
      };
      transporter.sendMail(mailOptions).then(() => console.log("✅ Email sent.")).catch(e => console.error("❌ Email failed:", e.message));
    }

    res.json({ success: true });
  } catch (err) { 
    console.error("POST /api/jobs/complete Error:", err.message);
    res.status(500).json({ error: err.message }); 
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "tote_scanner_mobile.html"));
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
