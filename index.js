require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Static files ----------
const STATIC_DIR = path.join(__dirname, 'public');
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(STATIC_DIR));
app.get('/', (_req, res) => res.sendFile(path.join(STATIC_DIR, 'index.html')));

// ---------- Names list ----------
const NAME_FILE = path.join(__dirname, 'dtlist.txt');
let names = [];
try {
  names = fs.readFileSync(NAME_FILE, 'utf-8')
    .split('\n')
    .map(n => n.trim())
    .filter(Boolean);
} catch (e) {
  console.error('❌ Could not load dtlist.txt:', e.message);
}

// ---------- Email ----------
const EMAIL_TO =
  'p.vuckovic@student.utwente.nl, a.krstovska@student.utwente.nl, n.j.wright@utwente.nl';

// ➕ NEW: Extra email only for TT-late check-ins
const EXTRA_TT_LATE_EMAIL = 'j.blok@utwente.nl'; //

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
});
transporter.verify(err => {
  if (err) console.error('❌ Email transporter failed:', err);
  else console.log('📬 Email transporter ready');
});

// ---------- Database ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function dbInit() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS checkins (
      id     SERIAL PRIMARY KEY,
      name   TEXT NOT NULL,
      team   TEXT NOT NULL,
      status TEXT NOT NULL,
      at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sent_reminders (
      id SERIAL PRIMARY KEY,
      team TEXT NOT NULL,
      shift_start_hour TIMESTAMPTZ NOT NULL,
      UNIQUE (team, shift_start_hour)
    );
  `);

  console.log('✅ DB ready');
}
dbInit().catch(err => {
  console.error('❌ DB init error:', err);
  process.exit(1);
});

// ---------- Shift helpers ----------
function getShiftStart(now, team) {
  const weekday = now.weekday; // 1 = Mon ... 7 = Sun

  if (team === 'DT') {
    return now.hour < 12
      ? now.set({ hour: 8,  minute: 30, second: 0, millisecond: 0 })
      : now.set({ hour: 13, minute: 30, second: 0, millisecond: 0 });
  }

  if (team === 'TT') {
    if (now.hour < 12) return now.set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
    if (weekday === 2) return now.set({ hour: 16, minute: 0, second: 0, millisecond: 0 });
    return now.set({ hour: 13, minute: 0, second: 0, millisecond: 0 });
  }

  return now;
}

// ---------- API ----------

// Names list (dropdown)
app.get('/names', (_req, res) => res.json(names));

// CHECK-IN
app.post('/checkin', async (req, res) => {
  try {
    const { name, team } = req.body;
    if (!name || !team) return res.status(400).json({ error: 'Missing name or team' });

    const now = DateTime.now().setZone('Europe/Amsterdam');
    const isWeekend = now.weekday >= 6;

    const shiftStart = getShiftStart(now, team);
    const earlyWindowStart = shiftStart.minus({ minutes: 30 });
    const lateThreshold = shiftStart.plus({ minutes: 10 });

    let status;

    // Weekend check-in
    if (isWeekend) {
      status = 'checkin-weekend';
    }

    // Inside 30-minute early window
    else if (now >= earlyWindowStart && now < shiftStart) {
      status = 'checkin-ontime';
    }

    // On-time window: shift start → +10 minutes
    else if (now >= shiftStart && now <= lateThreshold) {
      status = 'checkin-ontime';
    }

    // Late window
    else if (now > lateThreshold) {
      status = 'checkin-late';
    }

    // Too early → fallback to previous-shift logic
    else {
      const diffMins = Math.floor(now.diff(shiftStart, 'minutes').minutes);
      status = diffMins <= 10 ? 'checkin-ontime' : 'checkin-late';
    }

    // Insert log row
    await pool.query(
      'INSERT INTO checkins(name, team, status, at) VALUES ($1,$2,$3,$4)',
      [name, team, status, now.toISO()]
    );

    // Weekend email
    if (status === 'checkin-weekend') {
      const dayName = now.toFormat('cccc');
      await transporter.sendMail({
        from: process.env.MAIL_USER,
        to: EMAIL_TO,
        subject: `[${team}] ${name} has just checked in on ${dayName}!`,
        text: `${name} submitted a check-in on ${dayName}, ${now.toFormat('HH:mm')}`
      });
      return res.json({ success: true, status });
    }

    // LATE EMAIL — with TT extra recipient
    if (status === 'checkin-late') {
      const diffMins = Math.floor(now.diff(shiftStart, 'minutes').minutes);

      const recipients =
        team === 'TT'
          ? `${EMAIL_TO}, ${EXTRA_TT_LATE_EMAIL}`
          : EMAIL_TO;

      await transporter.sendMail({
        from: process.env.MAIL_USER,
        to: recipients,
        subject: `[${team}] ${name} has checked in late (${now.toFormat('HH:mm')})`,
        text: `${name} checked in at ${now.toFormat('HH:mm')}, which is ${diffMins} minutes after shift start.`
      });
    }

    res.json({ success: true, status });

  } catch (e) {
    console.error('❌ /checkin error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// CHECK-OUT
app.post('/checkout', async (req, res) => {
  try {
    const { name, team } = req.body;
    if (!name || !team) return res.status(400).json({ error: 'Missing name or team' });

    const now = DateTime.now().setZone('Europe/Amsterdam');
    const localTime = now.toFormat('HH:mm');

    await pool.query(
      'INSERT INTO checkins(name, team, status, at) VALUES ($1,$2,$3,$4)',
      [name, team, 'checkout', now.toISO()]
    );

    const shiftLabel = team === 'DT' ? 'DT Shift' : 'TT Shift';

    await transporter.sendMail({
      from: process.env.MAIL_USER,
      to: EMAIL_TO,
      subject: `${name} checked out (${shiftLabel})`,
      text: `${name} has checked out from their ${shiftLabel} at ${localTime}.`
    });

    res.json({ success: true, at: localTime });

  } catch (e) {
    console.error('❌ /checkout error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ADMIN: Download CSV log
app.get('/download-log', async (req, res) => {
  const auth = req.headers.authorization || '';
  const [scheme, encoded] = auth.split(' ');
  if (scheme !== 'Basic' || !encoded) return res.status(401).send('Missing authorization');

  const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':');
  if (user !== 'admin' || pass !== process.env.ADMIN_PASSWORD)
    return res.status(403).send('Forbidden');

  try {
    const { rows } = await pool.query(
      'SELECT name, at, team, status FROM checkins ORDER BY at DESC'
    );

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="checkins.csv"');
    res.write('name,time,team,status\n');

    for (const r of rows) {
      res.write(`${r.name},${new Date(r.at).toISOString()},${r.team},${r.status}\n`);
    }

    res.end();
  } catch (e) {
    console.error('❌ /download-log error:', e);
    res.status(500).send('DB error');
  }
});

// ---------- 20-minute reminder (multi-instance safe) ----------
setInterval(async () => {
  try {
    const now = DateTime.now().setZone('Europe/Amsterdam');
    if (now.weekday >= 6) return; // weekends skip

    for (const team of ['DT', 'TT']) {
      const shiftStart = getShiftStart(now, team);
      const diffMins = Math.floor(now.diff(shiftStart, 'minutes').minutes);

      if (diffMins === 20) {
        const { rowCount } = await pool.query(
          `SELECT 1
             FROM checkins
            WHERE team = $1
              AND status IN ('checkin-ontime','checkin-late','checkin-weekend')
              AND at >= $2
            LIMIT 1`,
          [team, shiftStart.toISO()]
        );

        if (rowCount === 0) {
          const shiftHour = shiftStart.startOf('hour').toISO();

          try {
            await pool.query(
              'INSERT INTO sent_reminders(team, shift_start_hour) VALUES ($1,$2)',
              [team, shiftHour]
            );

            await transporter.sendMail({
              from: process.env.MAIL_USER,
              to: EMAIL_TO,
              subject: `No ${team === 'DT' ? 'DreamTeamer' : 'TechTeamer'} has checked in yet (20 minutes past shift start)`,
              text: `As of ${now.toFormat('HH:mm')} no one from ${team} has checked in.`
            });
          } catch (err) {
            if (!/duplicate key|unique/i.test(err.message)) {
              console.error('reminder error:', err);
            }
          }
        }
      }
    }
  } catch (e) {
    console.error('❌ reminder loop error:', e);
  }
}, 60 * 1000);

// ---------- Start ----------
app.listen(PORT, () =>
  console.log(`🚀 Server running at http://localhost:${PORT}`)
);
