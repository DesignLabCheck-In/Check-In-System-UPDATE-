require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const path = require('path');
const crypto = require('crypto');
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

// ---------- Email ----------
const EMAIL_TO =
  'p.vuckovic@student.utwente.nl, a.krstovska@student.utwente.nl, n.j.wright@utwente.nl';

const EXTRA_TT_LATE_EMAIL = 'j.blok@utwente.nl';

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS
  }
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
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      team TEXT NOT NULL,
      status TEXT NOT NULL,
      at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS people (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      active BOOLEAN DEFAULT TRUE
    );
  `);

  console.log('✅ DB ready');
}

dbInit().catch(err => {
  console.error('❌ DB init error:', err);
  process.exit(1);
});

// ---------- Admin session ----------
const adminSessions = new Map();
const ADMIN_COOKIE_NAME = 'designlab_admin_session';

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(
    header
      .split(';')
      .map(part => part.trim())
      .filter(Boolean)
      .map(part => {
        const eqIndex = part.indexOf('=');
        if (eqIndex === -1) return [part, ''];
        return [part.slice(0, eqIndex), decodeURIComponent(part.slice(eqIndex + 1))];
      })
  );
}

function isAdminAuthenticated(req) {
  const cookies = parseCookies(req);
  const token = cookies[ADMIN_COOKIE_NAME];
  return token && adminSessions.has(token);
}

function requireAdmin(req, res, next) {
  if (!isAdminAuthenticated(req)) {
    return res.status(401).json({ error: 'Admin login required' });
  }
  next();
}

// ---------- Shift helpers ----------
function getShiftStart(now, team) {
  const weekday = now.weekday; // 1=Mon ... 7=Sun

  if (team === 'DT') {
    return now.hour < 12
      ? now.set({ hour: 8, minute: 30, second: 0, millisecond: 0 })
      : now.set({ hour: 13, minute: 30, second: 0, millisecond: 0 });
  }

  if (team === 'TT') {
    if (now.hour < 12) return now.set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
    if (weekday === 2) return now.set({ hour: 16, minute: 0, second: 0, millisecond: 0 });
    return now.set({ hour: 13, minute: 0, second: 0, millisecond: 0 });
  }

  return now;
}

// ---------- Auth routes ----------
app.post('/access/login', (req, res) => {
  const { password } = req.body || {};

  if (!process.env.SITE_PASSWORD) {
    return res.status(500).json({ error: 'SITE_PASSWORD is not configured' });
  }

  if (password !== process.env.SITE_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  res.json({ success: true });
});

app.post('/admin/login', (req, res) => {
  const { password } = req.body || {};

  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({ error: 'ADMIN_PASSWORD is not configured' });
  }

  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid admin password' });
  }

  const token = crypto.randomBytes(24).toString('hex');
  adminSessions.set(token, { createdAt: Date.now() });

  res.setHeader(
    'Set-Cookie',
    `${ADMIN_COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax`
  );

  res.json({ success: true });
});

app.post('/admin/logout', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies[ADMIN_COOKIE_NAME];

  if (token) adminSessions.delete(token);

  res.setHeader(
    'Set-Cookie',
    `${ADMIN_COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`
  );

  res.json({ success: true });
});

app.get('/admin/session', (req, res) => {
  res.json({ authenticated: !!isAdminAuthenticated(req) });
});

app.get('/admin.html', (req, res) => {
  if (!isAdminAuthenticated(req)) {
    return res.redirect('/');
  }

  res.sendFile(path.join(STATIC_DIR, 'admin.html'));
});

// ---------- API ----------

// Public names list
app.get('/names', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT name
      FROM people
      WHERE active = TRUE
      ORDER BY name ASC
    `);

    res.json(rows.map(row => row.name));
  } catch (e) {
    console.error('❌ /names error:', e);
    res.status(500).json({ error: 'Could not load names' });
  }
});

// CHECK-IN
app.post('/checkin', async (req, res) => {
  try {
    const { name, team } = req.body;
    if (!name || !team) {
      return res.status(400).json({ error: 'Missing name or team' });
    }

    const now = DateTime.now().setZone('Europe/Amsterdam');
    const isWeekend = now.weekday >= 6;

    const shiftStart = getShiftStart(now, team);
    const earlyWindowStart = shiftStart.minus({ minutes: 30 });
    const lateThreshold = shiftStart.plus({ minutes: 10 });

    let status;

    if (isWeekend) {
      status = 'checkin-weekend';
    } else if (now >= earlyWindowStart && now < shiftStart) {
      status = 'checkin-ontime';
    } else if (now >= shiftStart && now <= lateThreshold) {
      status = 'checkin-ontime';
    } else if (now > lateThreshold) {
      status = 'checkin-late';
    } else {
      const diffMins = Math.floor(now.diff(shiftStart, 'minutes').minutes);
      status = diffMins <= 10 ? 'checkin-ontime' : 'checkin-late';
    }

    await pool.query(
      'INSERT INTO checkins(name, team, status, at) VALUES ($1, $2, $3, $4)',
      [name, team, status, now.toISO()]
    );

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
    if (!name || !team) {
      return res.status(400).json({ error: 'Missing name or team' });
    }

    const now = DateTime.now().setZone('Europe/Amsterdam');
    const localTime = now.toFormat('HH:mm');

    await pool.query(
      'INSERT INTO checkins(name, team, status, at) VALUES ($1, $2, $3, $4)',
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

// ---------- ADMIN API ----------
app.get('/admin/people', requireAdmin, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, active FROM people ORDER BY name ASC'
    );
    res.json(rows);
  } catch (err) {
    console.error('admin people error:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

app.post('/admin/people', requireAdmin, async (req, res) => {
  const name = (req.body?.name || '').trim();

  if (!name) {
    return res.status(400).json({ error: 'Name required' });
  }

  try {
    await pool.query(
      `
      INSERT INTO people(name, active)
      VALUES($1, TRUE)
      ON CONFLICT (name)
      DO UPDATE SET active = TRUE
      `,
      [name]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('add person error:', err);
    res.status(500).json({ error: 'Could not add person' });
  }
});

app.delete('/admin/people/:id', requireAdmin, async (req, res) => {
  const id = req.params.id;

  try {
    await pool.query(
      'UPDATE people SET active = FALSE WHERE id = $1',
      [id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('remove person error:', err);
    res.status(500).json({ error: 'Could not remove person' });
  }
});

// Protected CSV download
app.get('/download-log', requireAdmin, async (_req, res) => {
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

// ---------- 20-minute reminder ----------
setInterval(async () => {
  try {
    const now = DateTime.now().setZone('Europe/Amsterdam');
    if (now.weekday >= 6) return;

    for (const team of ['DT', 'TT']) {
      const shiftStart = getShiftStart(now, team);
      const diffMins = Math.floor(now.diff(shiftStart, 'minutes').minutes);

      if (diffMins === 20) {
        const { rowCount } = await pool.query(
          `SELECT 1
           FROM checkins
           WHERE team = $1
             AND status IN ('checkin-ontime', 'checkin-late', 'checkin-weekend')
             AND at >= $2
           LIMIT 1`,
          [team, shiftStart.toISO()]
        );

        if (rowCount === 0) {
          const shiftHour = shiftStart.startOf('hour').toISO();

          try {
            await pool.query(
              'INSERT INTO sent_reminders(team, shift_start_hour) VALUES ($1, $2)',
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
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
