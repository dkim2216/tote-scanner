const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const path = require("path");
const nodemailer = require("nodemailer");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

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

// DB 테이블 생성 (최초 1회)
const initDB = async () => {
  try {
    await pool.query(`
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
    `);
    console.log("DB Tables Ready");
  } catch (err) {
    console.error("DB Init Error:", err);
  }
};
initDB();

app.get("/api/jobs", async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 50');
    res.json(result.rows);
  } catch (err) { res.status(500).json([]); }
});

app.post("/api/jobs", async (req, res) => {
  const { manifest_no, label, totes } = req.body;
  try {
    const jobRes = await pool.query(
      'INSERT INTO jobs (manifest_no, label, total_totes) VALUES ($1, $2, $3) RETURNING id',
      [manifest_no, label, totes.length]
    );
    res.json({ id: jobRes.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/jobs/:id/complete/:mode", async (req, res) => {
  const { id, mode } = req.params;
  const { scanned = [], missed = [] } = req.body;
  try {
    // DB 업데이트
    if (mode === "load") {
      await pool.query('UPDATE jobs SET load_completed_at=NOW(), load_scanned=$1, load_missed=$2 WHERE id=$3', [scanned.length, missed.length, id]);
    } else {
      await pool.query('UPDATE jobs SET offload_completed_at=NOW(), offload_scanned=$1, offload_missed=$2 WHERE id=$3', [scanned.length, missed.length, id]);
    }

    // 이메일 발송 시도
    if (process.env.SMTP_USER && process.env.ADMIN_EMAIL) {
      const mailOptions = {
        from: process.env.SMTP_USER,
        to: process.env.ADMIN_EMAIL,
        subject: `[Tote Scanner] ${mode.toUpperCase()} Complete - ${id}`,
        text: `Job ID: ${id}\nMode: ${mode}\nScanned: ${scanned.length}\nMissed: ${missed.length}\nTime: ${new Date().toLocaleString()}`
      };
      await transporter.sendMail(mailOptions);
    }

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "tote_scanner_mobile.html"));
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
