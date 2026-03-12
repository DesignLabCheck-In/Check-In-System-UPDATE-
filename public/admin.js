const WEEKDAY_NAMES = {
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
  7: 'Sunday'
};

let activeTeam = 'DT';

function showAdminFeedback(message, isError = false) {
  const box = document.getElementById('admin-feedback');
  box.textContent = message;
  box.style.display = 'block';
  box.className = isError ? 'admin-feedback error' : 'admin-feedback';
}

async function ensureAdminSession() {
  const res = await fetch('/admin/session');
  const data = await res.json();

  if (!data.authenticated) {
    window.location.href = '/';
    return false;
  }

  return true;
}

async function loadSettings() {
  const res = await fetch('/admin/settings');
  if (res.status === 401) {
    window.location.href = '/';
    return;
  }

  const settings = await res.json();
  document.getElementById('early_checkin_minutes').value = settings.early_checkin_minutes;
  document.getElementById('late_grace_minutes').value = settings.late_grace_minutes;
}

async function loadPeople() {
  const res = await fetch('/admin/people');
  if (res.status === 401) {
    window.location.href = '/';
    return;
  }

  const people = await res.json();
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

    btn.onclick = async () => {
      const removeRes = await fetch('/admin/people/' + p.id, {
        method: 'DELETE'
      });

      if (removeRes.status === 401) {
        window.location.href = '/';
        return;
      }

      if (!removeRes.ok) {
        showAdminFeedback('Could not remove person.', true);
        return;
      }

      await loadPeople();
      showAdminFeedback('Person removed.');
    };

    li.appendChild(nameSpan);
    li.appendChild(btn);
    list.appendChild(li);
  });
}

function renderShiftGroups(shifts) {
  const container = document.getElementById('shift-groups');
  container.innerHTML = '';

  for (let weekday = 1; weekday <= 7; weekday += 1) {
    const dayCard = document.createElement('div');
    dayCard.className = 'shift-day-card';

    const title = document.createElement('h3');
    title.textContent = WEEKDAY_NAMES[weekday];
    dayCard.appendChild(title);

    const dayShifts = shifts.filter(shift => Number(shift.weekday) === weekday);

    if (!dayShifts.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'No shifts configured.';
      dayCard.appendChild(empty);
    } else {
      dayShifts.forEach(shift => {
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

        saveBtn.onclick = async () => {
          const res = await fetch('/admin/shifts/' + shift.id, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              shift_name: nameInput.value.trim(),
              start_time: timeInput.value,
              active: toggle.checked
            })
          });

          if (res.status === 401) {
            window.location.href = '/';
            return;
          }

          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            showAdminFeedback(data.error || 'Could not update shift.', true);
            return;
          }

          await loadShifts(activeTeam);
          showAdminFeedback('Shift updated.');
        };

        deleteBtn.onclick = async () => {
          const confirmed = window.confirm('Delete this shift?');
          if (!confirmed) return;

          const res = await fetch('/admin/shifts/' + shift.id, {
            method: 'DELETE'
          });

          if (res.status === 401) {
            window.location.href = '/';
            return;
          }

          if (!res.ok) {
            showAdminFeedback('Could not delete shift.', true);
            return;
          }

          await loadShifts(activeTeam);
          showAdminFeedback('Shift deleted.');
        };

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
  const res = await fetch('/admin/shifts?team=' + encodeURIComponent(team));
  if (res.status === 401) {
    window.location.href = '/';
    return;
  }

  const shifts = await res.json();
  renderShiftGroups(shifts);
}

function setActiveTeam(team) {
  activeTeam = team;
  document.getElementById('tab-DT').classList.toggle('active', team === 'DT');
  document.getElementById('tab-TT').classList.toggle('active', team === 'TT');
  loadShifts(team);
}

document.getElementById('settings-form').onsubmit = async (e) => {
  e.preventDefault();

  const payload = {
    early_checkin_minutes: document.getElementById('early_checkin_minutes').value,
    late_grace_minutes: document.getElementById('late_grace_minutes').value
  };

  const res = await fetch('/admin/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (res.status === 401) {
    window.location.href = '/';
    return;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showAdminFeedback(data.error || 'Could not save settings.', true);
    return;
  }

  showAdminFeedback('Global rules saved.');
};

document.getElementById('add-shift').onclick = async () => {
  const payload = {
    team: activeTeam,
    weekday: Number(document.getElementById('new-shift-weekday').value),
    shift_name: document.getElementById('new-shift-name').value.trim(),
    start_time: document.getElementById('new-shift-time').value,
    active: document.getElementById('new-shift-active').checked
  };

  const res = await fetch('/admin/shifts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (res.status === 401) {
    window.location.href = '/';
    return;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showAdminFeedback(data.error || 'Could not add shift.', true);
    return;
  }

  document.getElementById('new-shift-name').value = '';
  document.getElementById('new-shift-time').value = '';
  document.getElementById('new-shift-active').checked = true;

  await loadShifts(activeTeam);
  showAdminFeedback('Shift added.');
};

document.getElementById('add-person').onclick = async () => {
  const nameInput = document.getElementById('new-name');
  const name = nameInput.value.trim();

  if (!name) return;

  const res = await fetch('/admin/people', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });

  if (res.status === 401) {
    window.location.href = '/';
    return;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showAdminFeedback(data.error || 'Could not add person.', true);
    return;
  }

  nameInput.value = '';
  await loadPeople();
  showAdminFeedback('Person added.');
};

document.getElementById('download-log').onclick = async () => {
  const res = await fetch('/download-log');

  if (res.status === 401) {
    window.location.href = '/';
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
};

document.getElementById('admin-logout').onclick = async () => {
  await fetch('/admin/logout', { method: 'POST' });
  window.location.href = '/';
};

document.getElementById('tab-DT').onclick = () => setActiveTeam('DT');
document.getElementById('tab-TT').onclick = () => setActiveTeam('TT');

(async () => {
  const ok = await ensureAdminSession();
  if (!ok) return;

  await loadSettings();
  await loadPeople();
  await loadShifts(activeTeam);
})();
