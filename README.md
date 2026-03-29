# Tote Scanner — Full Stack Setup

## Architecture

```
tote_scanner_mobile.html   ← Mobile UI (open in browser / PDA)
server/
  server.js                ← Node.js + Express API
  package.json
  .env.example             ← Copy to .env and fill in
  tote_scanner.db          ← SQLite DB (auto-created on first run)
sample_manifest.csv        ← Example CSV format
```

---

## 1. Start the Backend Server

```bash
cd server
npm install
cp .env.example .env       # then edit .env with your SMTP details
node server.js
```

Server starts at http://localhost:3001

---

## 2. Open the App

Open tote_scanner_mobile.html in any browser.
The server also serves it at: http://YOUR_SERVER_IP:3001/tote_scanner_mobile.html

---

## 3. CSV Format

```
tote_id,store_id
TOTE-001,Store A
TOTE-002,Store A
TOTE-003,Store B
```

---

## 4. Gmail Setup

1. Enable 2FA on Google account
2. Go to https://myaccount.google.com/apppasswords
3. Create App Password for "Mail"
4. Add to .env:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=yourwarehouse@gmail.com
SMTP_PASS=xxxx xxxx xxxx xxxx
ADMIN_EMAIL=manager@company.com
```

---

## 5. Workflow

1. MANIFEST — Enter Manifest No. → Upload CSV
2. LOAD tab — Scan totes → COMPLETE MANIFEST (email sent if missed)
3. OFFLOAD tab — Scan totes → SORT TO card shows destination store → COMPLETE MANIFEST
4. VERIFY tab — Live scanned vs missed per store
5. HISTORY tab — All past jobs, tap for missed tote detail

---

## 6. Database Tables

- jobs: manifest_no, dates, load/offload counts, status
- totes: all totes per job
- scan_records: every successful scan with timestamp
- missed_records: unscanned totes at completion time
