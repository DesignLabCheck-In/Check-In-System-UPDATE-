const WEEKDAY_NAMES = {
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday'
};

let activeTeam = 'DT';
let toastTimer = null;

function showToast(message, isError = false) {
  const box = document.getElementById('admin-toast');
  if (!box) return;

  box.textContent = message;
  box.className = isError ? 'admin-toast show error' : 'admin-toast show';

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.className = 'admin-toast';
  }, 2600);
}

function redirectHome() {
  window.location.href = '/';
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);

  if (res.status === 401) {
    redirectHome();
    return null;
  }

  const contentType = res.headers.get('content-type') || '';
  let data = null;

  if (contentType.includes('application/json')) {
    data = await res.json();
  } else {
    const text = await res.text();
    data = { error: text || 'Unexpected server response' };
  }

  return { res, data };
}

async function ensureAdminSession() {
  const result = await fetchJson('/admin/session');
  if (!result) return false;

  if (!result.data.authenticated) {
    redirectHome();
    return false;
  }

  return true;
}

async function loadSettings() {
  const result = await fetchJson('/admin/settings');
  if (!result) return;

  const settings = result.data;
  document.getElementById('early_checkin_minutes').value = settings.early_checkin_minutes ?? '';
  document.getElementById('late_grace_minutes').value = settings.late_grace_minutes ?? '';
  document.getElementById('no_checkin_reminder_minutes').value = settings.no_checkin_reminder_minutes ?? '';
}

async function loadNotifications() {
  const result = await fetchJson('/admin/notifications');
  if (!result) return;

  const settings = result.data;
  document.getElementById('default_recipients').value = settings.default_recipients || '';
  document.getElementById('tt_late_extra_recipients').value = settings.tt_late_extra_recipients || '';
  document.getElementById('send_late_emails').checked = Boolean(settings.send_late_emails);
  document.getElementById('send_checkout_emails').checked = Boolean(settings.send_checkout_emails);
  document.getElementById('send_reminder_emails').checked = Boolean(settings.send_reminder_emails);
}

async function loadPeople() {
  const result = await fetchJson('/admin/people');
  if (!result) return;

  const people = result.data;
  const list = document.getElementById('people-list');
  list.innerHTML = '';

  people.forEach((p) => {
    if (!p.active) return;

    const li = document.createElement('li');
    li.className = 'people-list-item';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = p.name;
    nameSpan.className = 'person-name';

    const btn = document.createElement('button');
    btn.textContent = 'Remove';
    btn.type = 'button';
    btn.className = 'remove-btn';

    btn.addEventListener('click', async () => {
  const confirmed = window.confirm(`Are you sure you want to eliminate ${p.name}?`);
  if (!confirmed) return;

  const removeResult = await fetchJson('/admin/people/' + p.id, {
    method: 'DELETE'
  });

  if (!removeResult) return;

  if (!removeResult.res.ok) {
    showToast(removeResult.data.error || 'Could not remove person.', true);
    return;
  }

  await loadPeople();
  showToast(`${p.name} was removed.`);
});

    li.appendChild(nameSpan);
    li.appendChild(btn);
    list.appendChild(li);
  });
}

function renderShiftGroups(shifts) {
  const container = document.getElementById('shift-groups');
  container.innerHTML = '';

  for (let weekday = 1; weekday <= 5; weekday += 1) {
    const dayCard = document.createElement('div');
    dayCard.className = 'shift-day-card';

    const title = document.createElement('h3');
    title.textContent = WEEKDAY_NAMES[weekday];
    dayCard.appendChild(title);

    const dayShifts = shifts.filter((shift) => Number(shift.weekday) === weekday);

    if (!dayShifts.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'No shifts configured.';
      dayCard.appendChild(empty);
    } else {
      dayShifts.forEach((shift) => {
        const row = document.createElement('div');
        row.className = 'shift-row';

        const nameInput = document.createElement('input');
        nameInput.className = 'admin-input';
        nameInput.value = shift.shift_name;

        const timeInput = document.createElement('input');
        timeInput.className = 'admin-input';
        timeInput.type = 'time';
        timeInput.value = shift.start_time;

        const toggleWrap = document.createElement('label');
        toggleWrap.className = 'shift-toggle';

        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.checked = Boolean(shift.active);

        const toggleText = document.createElement('span');
        toggleText.textContent = 'Enabled';

        toggleWrap.appendChild(toggle);
        toggleWrap.appendChild(toggleText);

        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.textContent = 'Save';

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.textContent = 'Delete';
        deleteBtn.className = 'remove-btn';

        saveBtn.addEventListener('click', async () => {
          const result = await fetchJson('/admin/shifts/' + shift.id, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              shift_name: nameInput.value.trim(),
              start_time: timeInput.value,
              active: toggle.checked
            })
          });

          if (!result) return;

          if (!result.res.ok) {
            showToast(result.data.error || 'Could not update shift.', true);
            return;
          }

          await loadShifts(activeTeam);
          showToast('Shift updated.');
        });

        deleteBtn.addEventListener('click', async () => {
          const confirmed = window.confirm('Delete this shift?');
          if (!confirmed) return;

          const result = await fetchJson('/admin/shifts/' + shift.id, {
            method: 'DELETE'
          });

          if (!result) return;

          if (!result.res.ok) {
            showToast(result.data.error || 'Could not delete shift.', true);
            return;
          }

          await loadShifts(activeTeam);
          showToast('Shift deleted.');
        });

        row.appendChild(nameInput);
        row.appendChild(timeInput);
        row.appendChild(toggleWrap);
        row.appendChild(saveBtn);
        row.appendChild(deleteBtn);
        dayCard.appendChild(row);
      });
    }

    container.appendChild(dayCard);
  }
}

async function loadShifts(team) {
  const result = await fetchJson('/admin/shifts?team=' + encodeURIComponent(team));
  if (!result) return;

  if (!result.res.ok) {
    showToast(result.data.error || 'Could not load shifts.', true);
    return;
  }

  renderShiftGroups(result.data);
}

function setActiveTeam(team) {
  activeTeam = team;
  document.getElementById('tab-DT').classList.toggle('active', team === 'DT');
  document.getElementById('tab-TT').classList.toggle('active', team === 'TT');
  loadShifts(team);
}

function wireCollapsibles() {
  document.querySelectorAll('.collapsible-card').forEach((card) => {
    const toggle = card.querySelector('.collapse-toggle');
    if (!toggle) return;

    toggle.addEventListener('click', () => {
      card.classList.toggle('open');
    });
  });
}

function wireEventHandlers() {
  document.getElementById('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const result = await fetchJson('/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        early_checkin_minutes: document.getElementById('early_checkin_minutes').value,
        late_grace_minutes: document.getElementById('late_grace_minutes').value,
        no_checkin_reminder_minutes: document.getElementById('no_checkin_reminder_minutes').value
      })
    });

    if (!result) return;

    if (!result.res.ok) {
      showToast(result.data.error || 'Could not save settings.', true);
      return;
    }

    showToast('Grace periods saved.');
  });

  document.getElementById('notifications-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const result = await fetchJson('/admin/notifications', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        default_recipients: document.getElementById('default_recipients').value,
        tt_late_extra_recipients: document.getElementById('tt_late_extra_recipients').value,
        send_late_emails: document.getElementById('send_late_emails').checked,
        send_checkout_emails: document.getElementById('send_checkout_emails').checked,
        send_reminder_emails: document.getElementById('send_reminder_emails').checked
      })
    });

    if (!result) return;

    if (!result.res.ok) {
      showToast(result.data.error || 'Could not save email settings.', true);
      return;
    }

    showToast('Email settings saved.');
  });

  document.getElementById('add-shift').addEventListener('click', async () => {
    const result = await fetchJson('/admin/shifts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team: activeTeam,
        weekday: Number(document.getElementById('new-shift-weekday').value),
        shift_name: document.getElementById('new-shift-name').value.trim(),
        start_time: document.getElementById('new-shift-time').value,
        active: document.getElementById('new-shift-active').checked
      })
    });

    if (!result) return;

    if (!result.res.ok) {
      showToast(result.data.error || 'Could not add shift.', true);
      return;
    }

    document.getElementById('new-shift-name').value = '';
    document.getElementById('new-shift-time').value = '';
    document.getElementById('new-shift-active').checked = true;

    await loadShifts(activeTeam);
    showToast('Shift added.');
  });

  document.getElementById('add-person').addEventListener('click', async () => {
    const nameInput = document.getElementById('new-name');
    const name = nameInput.value.trim();
    if (!name) return;

    const result = await fetchJson('/admin/people', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });

    if (!result) return;

    if (!result.res.ok) {
      showToast(result.data.error || 'Could not add person.', true);
      return;
    }

    nameInput.value = '';
    await loadPeople();
    showToast('Person added.');
  });

  document.getElementById('download-log').addEventListener('click', async () => {
    const res = await fetch('/download-log');

    if (res.status === 401) {
      redirectHome();
      return;
    }

    if (!res.ok) {
      showToast('Could not download log.', true);
      return;
    }

    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'checkins.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  });

  document.getElementById('admin-logout').addEventListener('click', async () => {
    await fetch('/admin/logout', { method: 'POST' });
    redirectHome();
  });

  document.getElementById('tab-DT').addEventListener('click', () => setActiveTeam('DT'));
  document.getElementById('tab-TT').addEventListener('click', () => setActiveTeam('TT'));
}

document.addEventListener('DOMContentLoaded', async () => {
  wireCollapsibles();
  wireEventHandlers();

  const ok = await ensureAdminSession();
  if (!ok) return;

  await loadSettings();
  await loadNotifications();
  await loadPeople();
  await loadShifts(activeTeam);
});
