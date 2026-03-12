async function loadPeople() {
  const res = await fetch('/admin/people');
  const people = await res.json();

  const list = document.getElementById('people-list');
  list.innerHTML = '';

  people.forEach(p => {
    if (!p.active) return;

    const li = document.createElement('li');
    li.textContent = p.name;

    const btn = document.createElement('button');
    btn.textContent = 'Remove';

    btn.onclick = async () => {
      await fetch('/admin/people/' + p.id, {
        method: 'DELETE'
      });

      loadPeople();
    };

    li.appendChild(btn);
    list.appendChild(li);
  });
}

document.getElementById('add-person').onclick = async () => {
  const name = document.getElementById('new-name').value;

  if (!name) return;

  await fetch('/admin/people', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ name })
  });

  document.getElementById('new-name').value = '';
  loadPeople();
};

loadPeople();
