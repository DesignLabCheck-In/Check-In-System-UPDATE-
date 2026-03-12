async function loadPeople() {
  const res = await fetch('/admin/people');
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
      await fetch('/admin/people/' + p.id, {
        method: 'DELETE'
      });
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

  await fetch('/admin/people', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ name })
  });

  nameInput.value = '';
  loadPeople();
};

loadPeople();
