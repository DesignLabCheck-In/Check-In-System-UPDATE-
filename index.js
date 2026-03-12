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

const STATIC_DIR = path.join(__dirname, 'public');
const ADMIN_COOKIE_NAME = 'designlab_admin_session';
const WEEKDAY_NAMES = {
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
  7: 'Sunday'
};

const DEFAULT_SETTINGS = {
  early_checkin_minutes: '30',
  late_grace_minutes: '10',
  no_checkin_reminder_minutes: '20'
};

const DEFAULT_NOTIFICATION_SETTINGS = {
  default_recipients: 'p.vuckovic@student.utwente.nl, a.krstovska@student.utwente.nl, n.j.wright@utwente.nl',
  tt_late_extra_recipients: 'j.blok@utwente.nl',
  send_late_emails: 'true',
  send_checkout_emails: 'true',
  send_reminder_emails: 'true'
};

const adminSessions = new Map();

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(STATIC_DIR));

app.get('/', (_req, res) => {
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

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
      shift_name TEXT,
      at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await ensureCheckinsShiftNameColumn();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sent_reminders (
      id SERIAL PRIMARY KEY,
      team TEXT NOT NULL,
      shift_rule_id INT NOT NULL,
      shift_date DATE NOT NULL,
      UNIQUE (team, shift_rule_id, shift_date)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS people (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      active BOOLEAN DEFAULT TRUE
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notification_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shift_rules (
      id SERIAL PRIMARY KEY,
      team TEXT NOT NULL,
      weekday INT NOT NULL,
      shift_name TEXT NOT NULL,
      start_time TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE
    );
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS shift_rules_unique_idx
    ON shift_rules(team, weekday, shift_name);
  `);

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await pool.query(
      `
      INSERT INTO app_settings (key, value)
      VALUES ($1, $2)
      ON CONFLICT (key) DO NOTHING
      `,
      [key, value]
    );
  }

  for (const [key, value] of Object.entries(DEFAULT_NOTIFICATION_SETTINGS)) {
    await pool.query(
      `
      INSERT INTO notification_settings (key, value)
      VALUES ($1, $2)
      ON CONFLICT (key) DO NOTHING
      `,
      [key, value]
    );
  }

  console.log('✅ DB ready');
}

async function ensureCheckinsShiftNameColumn() {
  const result = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'checkins'
      AND column_name = 'shift_name'
  `);

  if (result.rowCount === 0) {
    await pool.query(`ALTER TABLE checkins ADD COLUMN shift_name TEXT`);
  }
}

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
  return Boolean(token && adminSessions.has(token));
}

function requireAdmin(req, res, next) {
  if (!isAdminAuthenticated(req)) {
    return res.status(401).json({ error: 'Admin login required' });
  }
  next();
}

async function getAppSettings() {
  const { rows } = await pool.query('SELECT key, value FROM app_settings');
  const settings = { ...DEFAULT_SETTINGS };

  for (const row of rows) {
    settings[row.key] = row.value;
  }

  return {
  early_checkin_minutes: Number(settings.early_checkin_minutes),
  late_grace_minutes: Number(settings.late_grace_minutes),
  no_checkin_reminder_minutes: Number(settings.no_checkin_reminder_minutes)
  };
}

async function getNotificationSettings() {
  const { rows } = await pool.query('SELECT key, value FROM notification_settings');
  const settings = { ...DEFAULT_NOTIFICATION_SETTINGS };

  for (const row of rows) {
    settings[row.key] = row.value;
  }

  return {
    default_recipients: settings.default_recipients,
    tt_late_extra_recipients: settings.tt_late_extra_recipients,
    send_late_emails: settings.send_late_emails === 'true',
    send_checkout_emails: settings.send_checkout_emails === 'true',
    send_reminder_emails: settings.send_reminder_emails === 'true'
  };
}

function combineRecipients(...groups) {
  const parts = groups
    .flatMap(group => String(group || '').split(','))
    .map(v => v.trim())
    .filter(Boolean);

  return [...new Set(parts)].join(', ');
}

function timeStringToDate(now, hhmm) {
  const [hour, minute] = hhmm.split(':').map(Number);
  return now.set({ hour, minute, second: 0, millisecond: 0 });
}

function sortRulesByTime(rules) {
  return [...rules].sort((a, b) => a.start_time.localeCompare(b.start_time));
}

function findRelevantShiftRule(now, rules, earlyCheckinMinutes) {
  if (!rules.length) return null;

  const withTimes = sortRulesByTime(rules).map(rule => ({
    ...rule,
    start: timeStringToDate(now, rule.start_time)
  }));

  const candidate = withTimes.find(rule =>
    now >= rule.start.minus({ minutes: earlyCheckinMinutes }) &&
    now <= rule.start.plus({ hours: 8 })
  );

  if (candidate) return candidate;

  const future = withTimes.find(rule => now < rule.start);
  if (future) return future;

  return withTimes[withTimes.length - 1];
}

async function getShiftRulesForDay(team, weekday) {
  const { rows } = await pool.query(
    `
    SELECT id, team, weekday, shift_name, start_time, active
    FROM shift_rules
    WHERE team = $1
      AND weekday = $2
      AND active = TRUE
    ORDER BY start_time ASC, shift_name ASC
    `,
    [team, weekday]
  );

  return rows;
}

dbInit().catch(err => {
  console.error('❌ DB init error:', err);
  process.exit(1);
});

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
  res.json({ authenticated: isAdminAuthenticated(req) });
});

app.get('/admin.html', (req, res) => {
  if (!isAdminAuthenticated(req)) {
    return res.redirect('/');
  }
  res.sendFile(path.join(STATIC_DIR, 'admin.html'));
});

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

app.post('/checkin', async (req, res) => {
  try {
    const { name, team } = req.body;
    if (!name || !team) {
      return res.status(400).json({ error: 'Missing name or team' });
    }

    const now = DateTime.now().setZone('Europe/Amsterdam');
    const isWeekend = now.weekday >= 6;
    const settings = await getAppSettings();

    const rules = await getShiftRulesForDay(team, now.weekday);
    if (!rules.length) {
      if (isWeekend) {
        return res.json({
          success: true,
          status: 'checkin-weekend',
          shift_name: null
        });
      }

      return res.status(400).json({
        error: `No active shifts configured for ${team} on ${WEEKDAY_NAMES[now.weekday]}`
      });
    }

    const selectedRule = findRelevantShiftRule(now, rules, settings.early_checkin_minutes);
    if (!selectedRule) {
      return res.status(400).json({ error: 'Could not determine shift for this check-in' });
    }

    const shiftStart = selectedRule.start;
    const earlyWindowStart = shiftStart.minus({ minutes: settings.early_checkin_minutes });
    const lateThreshold = shiftStart.plus({ minutes: settings.late_grace_minutes });

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
      status = diffMins <= settings.late_grace_minutes ? 'checkin-ontime' : 'checkin-late';
    }

    await pool.query(
      `
      INSERT INTO checkins(name, team, status, shift_name, at)
      VALUES ($1, $2, $3, $4, $5)
      `,
      [name, team, status, selectedRule.shift_name, now.toISO()]
    );

    if (status === 'checkin-late') {
      const notifications = await getNotificationSettings();

      if (notifications.send_late_emails) {
        const recipients = team === 'TT'
          ? combineRecipients(
              notifications.default_recipients,
              notifications.tt_late_extra_recipients
            )
          : notifications.default_recipients;

        if (recipients) {
          const diffMins = Math.floor(now.diff(shiftStart, 'minutes').minutes);

          await transporter.sendMail({
            from: process.env.MAIL_USER,
            to: recipients,
            subject: `[${team}] ${name} has checked in late for ${selectedRule.shift_name} (${now.toFormat('HH:mm')})`,
            text: `${name} checked in at ${now.toFormat('HH:mm')} for shift "${selectedRule.shift_name}", which is ${diffMins} minutes after shift start.`
          });
        }
      }
    }

    res.json({
      success: true,
      status,
      shift_name: selectedRule.shift_name
    });
  } catch (e) {
    console.error('❌ /checkin error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/checkout', async (req, res) => {
  try {
    const { name, team } = req.body;
    if (!name || !team) {
      return res.status(400).json({ error: 'Missing name or team' });
    }

    const now = DateTime.now().setZone('Europe/Amsterdam');
    const localTime = now.toFormat('HH:mm');

    await pool.query(
      `
      INSERT INTO checkins(name, team, status, shift_name, at)
      VALUES ($1, $2, $3, $4, $5)
      `,
      [name, team, 'checkout', null, now.toISO()]
    );

    const notifications = await getNotificationSettings();

    if (notifications.send_checkout_emails && notifications.default_recipients) {
      await transporter.sendMail({
        from: process.env.MAIL_USER,
        to: notifications.default_recipients,
        subject: `${name} checked out (${team})`,
        text: `${name} has checked out from ${team} at ${localTime}.`
      });
    }

    res.json({ success: true, at: localTime });
  } catch (e) {
    console.error('❌ /checkout error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

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
  try {
    await pool.query('UPDATE people SET active = FALSE WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('remove person error:', err);
    res.status(500).json({ error: 'Could not remove person' });
  }
});

app.get('/admin/settings', requireAdmin, async (_req, res) => {
  try {
    const settings = await getAppSettings();
    res.json(settings);
  } catch (err) {
    console.error('settings load error:', err);
    res.status(500).json({ error: 'Could not load settings' });
  }
});

app.put('/admin/settings', requireAdmin, async (req, res) => {
  const {
  early_checkin_minutes,
  late_grace_minutes,
  no_checkin_reminder_minutes
  } = req.body || {};

  if (
  Number.isNaN(Number(early_checkin_minutes)) || Number(early_checkin_minutes) < 0 ||
  Number.isNaN(Number(late_grace_minutes)) || Number(late_grace_minutes) < 0 ||
  Number.isNaN(Number(no_checkin_reminder_minutes)) || Number(no_checkin_reminder_minutes) < 0
) {
  return res.status(400).json({ error: 'All timing values must be 0 or greater' });
}

  const updates = {
    early_checkin_minutes: String(early_checkin_minutes),
    late_grace_minutes: String(late_grace_minutes),
    no_checkin_reminder_minutes: String(no_checkin_reminder_minutes)
  };

  try {
    for (const [key, value] of Object.entries(updates)) {
      await pool.query(
        `
        INSERT INTO app_settings (key, value)
        VALUES ($1, $2)
        ON CONFLICT (key)
        DO UPDATE SET value = EXCLUDED.value
        `,
        [key, value]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error('settings save error:', err);
    res.status(500).json({ error: 'Could not save settings' });
  }
});

app.get('/admin/notifications', requireAdmin, async (_req, res) => {
  try {
    const settings = await getNotificationSettings();
    res.json(settings);
  } catch (err) {
    console.error('notification load error:', err);
    res.status(500).json({ error: 'Could not load notification settings' });
  }
});

app.put('/admin/notifications', requireAdmin, async (req, res) => {
  const {
    default_recipients,
    tt_late_extra_recipients,
    send_late_emails,
    send_checkout_emails,
    send_reminder_emails
  } = req.body || {};

  const updates = {
    default_recipients: String(default_recipients || '').trim(),
    tt_late_extra_recipients: String(tt_late_extra_recipients || '').trim(),
    send_late_emails: String(Boolean(send_late_emails)),
    send_checkout_emails: String(Boolean(send_checkout_emails)),
    send_reminder_emails: String(Boolean(send_reminder_emails))
  };

  try {
    for (const [key, value] of Object.entries(updates)) {
      await pool.query(
        `
        INSERT INTO notification_settings (key, value)
        VALUES ($1, $2)
        ON CONFLICT (key)
        DO UPDATE SET value = EXCLUDED.value
        `,
        [key, value]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error('notification save error:', err);
    res.status(500).json({ error: 'Could not save notification settings' });
  }
});

app.get('/admin/shifts', requireAdmin, async (req, res) => {
  const team = req.query.team;
  if (!team || !['DT', 'TT'].includes(team)) {
    return res.status(400).json({ error: 'Valid team is required' });
  }

  try {
    const { rows } = await pool.query(
      `
      SELECT id, team, weekday, shift_name, start_time, active
      FROM shift_rules
      WHERE team = $1
      ORDER BY weekday ASC, start_time ASC, shift_name ASC
      `,
      [team]
    );
    res.json(rows);
  } catch (err) {
    console.error('shift load error:', err);
    res.status(500).json({ error: 'Could not load shifts' });
  }
});

app.post('/admin/shifts', requireAdmin, async (req, res) => {
  const { team, weekday, shift_name, start_time, active } = req.body || {};
  const timePattern = /^\d{2}:\d{2}$/;

  if (!['DT', 'TT'].includes(team)) {
    return res.status(400).json({ error: 'Valid team is required' });
  }
  if (![1, 2, 3, 4, 5].includes(Number(weekday))) {
    return res.status(400).json({ error: 'Weekday must be 1-5' });
  }
  if (!shift_name || typeof shift_name !== 'string') {
    return res.status(400).json({ error: 'Shift name is required' });
  }
  if (!timePattern.test(start_time || '')) {
    return res.status(400).json({ error: 'Start time must use HH:MM format' });
  }

  try {
    const { rows } = await pool.query(
      `
      INSERT INTO shift_rules (team, weekday, shift_name, start_time, active)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, team, weekday, shift_name, start_time, active
      `,
      [team, Number(weekday), shift_name.trim(), start_time, Boolean(active)]
    );
    res.json({ success: true, shift: rows[0] });
  } catch (err) {
    console.error('shift create error:', err);
    if (/unique/i.test(err.message)) {
      return res.status(400).json({ error: 'A shift with that name already exists for that day and team' });
    }
    res.status(500).json({ error: 'Could not add shift' });
  }
});

app.put('/admin/shifts/:id', requireAdmin, async (req, res) => {
  const { shift_name, start_time, active } = req.body || {};
  const timePattern = /^\d{2}:\d{2}$/;

  if (!shift_name || typeof shift_name !== 'string') {
    return res.status(400).json({ error: 'Shift name is required' });
  }
  if (!timePattern.test(start_time || '')) {
    return res.status(400).json({ error: 'Start time must use HH:MM format' });
  }

  try {
    await pool.query(
      `
      UPDATE shift_rules
      SET shift_name = $1,
          start_time = $2,
          active = $3
      WHERE id = $4
      `,
      [shift_name.trim(), start_time, Boolean(active), req.params.id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('shift update error:', err);
    if (/unique/i.test(err.message)) {
      return res.status(400).json({ error: 'A shift with that name already exists for that day and team' });
    }
    res.status(500).json({ error: 'Could not update shift' });
  }
});

app.delete('/admin/shifts/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM shift_rules WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('shift delete error:', err);
    res.status(500).json({ error: 'Could not delete shift' });
  }
});

app.get('/download-log', requireAdmin, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT name, at, team, status, shift_name FROM checkins ORDER BY at DESC'
    );

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="checkins.csv"');
    res.write('name,time,team,status,shift_name\n');

    for (const r of rows) {
      const shiftName = r.shift_name || '';
      res.write(`${r.name},${new Date(r.at).toISOString()},${r.team},${r.status},${shiftName}\n`);
    }

    res.end();
  } catch (e) {
    console.error('❌ /download-log error:', e);
    res.status(500).send('DB error');
  }
});

setInterval(async () => {
  try {
    const now = DateTime.now().setZone('Europe/Amsterdam');
    if (now.weekday >= 6) return;

    const notifications = await getNotificationSettings();
    if (!notifications.send_reminder_emails || !notifications.default_recipients) return;

    const settings = await getAppSettings();

    for (const team of ['DT', 'TT']) {
      const rules = await getShiftRulesForDay(team, now.weekday);
      if (!rules.length) continue;

      for (const rule of rules) {
        const shiftStart = timeStringToDate(now, rule.start_time);
        const diffMins = Math.floor(now.diff(shiftStart, 'minutes').minutes);

        if (diffMins === settings.no_checkin_reminder_minutes) {
          const { rowCount } = await pool.query(
            `
            SELECT 1
            FROM checkins
            WHERE team = $1
              AND shift_name = $2
              AND status IN ('checkin-ontime', 'checkin-late', 'checkin-weekend')
              AND at >= $3
            LIMIT 1
            `,
            [team, rule.shift_name, shiftStart.toISO()]
          );

          if (rowCount === 0) {
            try {
              await pool.query(
                `
                INSERT INTO sent_reminders(team, shift_rule_id, shift_date)
                VALUES ($1, $2, $3)
                `,
                [team, rule.id, now.toISODate()]
              );

              await transporter.sendMail({
                from: process.env.MAIL_USER,
                to: notifications.default_recipients,
                subject: `No ${team} check-in yet for ${rule.shift_name} (${WEEKDAY_NAMES[now.weekday]})`,
                text: `As of ${now.toFormat('HH:mm')} nobody has checked in for ${team} shift "${rule.shift_name}".`
              });
            } catch (err) {
              if (!/duplicate key|unique/i.test(err.message)) {
                console.error('reminder error:', err);
              }
            }
          }
        }
      }
    }

    void settings;
  } catch (e) {
    console.error('❌ reminder loop error:', e);
  }
}, 60 * 1000);

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
