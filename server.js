const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const path = require("path");
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

// API: 모든 작업 목록 가져오기
app.get("/api/jobs", async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 50');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json([]);
  }
});

// API: 새 작업 생성
app.post("/api/jobs", async (req, res) => {
  const { manifest_no, label, totes } = req.body;
  try {
    const jobRes = await pool.query(
      'INSERT INTO jobs (manifest_no, label, total_totes) VALUES ($1, $2, $3) RETURNING id',
      [manifest_no, label, totes.length]
    );
    res.json({ id: jobRes.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 메인 화면 제공
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "tote_scanner_mobile.html"));
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
