async function ensureAdminSession() {
  const res = await fetch('/admin/session');
  const data = await res.json();

  if (!data.authenticated) {
    window.location.href = '/';
    return false;
  }

  return true;
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

      loadPeople();
    };

    li.appendChild(nameSpan);
    li.appendChild(btn);
    list.appendChild(li);
  });
}

document.getElementById('add-person').onclick = async () => {
  const nameInput = document.getElementById('new-name');
  const name = nameInput.value.trim();

  if (!name) return;

  const res = await fetch('/admin/people', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ name })
  });

  if (res.status === 401) {
    window.location.href = '/';
    return;
  }

  nameInput.value = '';
  loadPeople();
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

(async () => {
  const ok = await ensureAdminSession();
  if (ok) loadPeople();
})();
