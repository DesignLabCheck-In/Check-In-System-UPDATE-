const form = document.getElementById('checkin-form');
const nameSelect = document.getElementById('name-select');
const teamSelect = document.getElementById('team-select');
const checkinBtn = document.getElementById('checkin-btn');
const checkoutBtn = document.getElementById('checkout-btn');

const accessModal = document.getElementById('access-modal');
const accessPasswordInput = document.getElementById('access-password');
const accessSubmit = document.getElementById('access-submit');

const adminBtn = document.getElementById('admin-download');
const adminModal = document.getElementById('admin-modal');
const adminPasswordInput = document.getElementById('admin-password');
const adminSubmit = document.getElementById('admin-submit');
const adminCancel = document.getElementById('admin-cancel');

const feedbackModal = document.getElementById('checkin-modal');
const feedbackMessage = document.getElementById('checkin-message');
const feedbackClose = document.getElementById('checkin-close');

const ACCESS_STORAGE_KEY = 'designlab_access_granted';

function showFeedback(message) {
  feedbackMessage.textContent = message;
  feedbackModal.style.display = 'flex';
}

function hideFeedback() {
  feedbackModal.style.display = 'none';
}

feedbackClose.addEventListener('click', hideFeedback);

async function loadNames() {
  try {
    const res = await fetch('/names');
    const names = await res.json();

    nameSelect.innerHTML = '<option value="">Select your name</option>';

    for (const name of names) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      nameSelect.appendChild(option);
    }
  } catch (err) {
    console.error('Error loading names:', err);
    showFeedback('Could not load names. Please refresh and try again.');
  }
}

async function verifySiteAccess(password) {
  const res = await fetch('/access/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  });

  return res;
}

async function submitAction(endpoint) {
  const name = nameSelect.value;
  const team = teamSelect.value;

  if (!name || !team) {
    showFeedback('Please select both your name and team.');
    return;
  }

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, team })
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      showFeedback(data.error || 'Server error.');
      return;
    }

    if (endpoint === '/checkout') {
      showFeedback(`Checked out successfully at ${data.at}.`);
      form.reset();
      return;
    }

    if (data.status === 'checkin-ontime') {
      showFeedback('Check-in successful.');
    } else if (data.status === 'checkin-late') {
      showFeedback('Check-in successful. You were marked late.');
    } else if (data.status === 'checkin-weekend') {
      showFeedback('Check-in successful. Weekend check-in recorded.');
    } else {
      showFeedback('Check-in successful.');
    }

    form.reset();
  } catch (err) {
    console.error('Submit error:', err);
    showFeedback('Server error.');
  }
}

accessSubmit.addEventListener('click', async () => {
  const password = accessPasswordInput.value.trim();

  if (!password) {
    showFeedback('Please enter the access password.');
    return;
  }

  try {
    const res = await verifySiteAccess(password);

    if (!res.ok) {
      showFeedback('Incorrect access password.');
      accessPasswordInput.value = '';
      return;
    }

    localStorage.setItem(ACCESS_STORAGE_KEY, 'true');
    accessModal.style.display = 'none';
    accessPasswordInput.value = '';
  } catch (err) {
    console.error('Access verify error:', err);
    showFeedback('Could not verify access password.');
  }
});

accessPasswordInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') accessSubmit.click();
});

if (localStorage.getItem(ACCESS_STORAGE_KEY) === 'true') {
  accessModal.style.display = 'none';
} else {
  accessModal.style.display = 'flex';
}

form.addEventListener('submit', async e => {
  e.preventDefault();
  await submitAction('/checkin');
});

checkoutBtn.addEventListener('click', async () => {
  await submitAction('/checkout');
});

adminBtn.addEventListener('click', () => {
  adminModal.style.display = 'flex';
  adminPasswordInput.value = '';
  adminPasswordInput.focus();
});

adminCancel.addEventListener('click', () => {
  adminModal.style.display = 'none';
  adminPasswordInput.value = '';
});

adminSubmit.addEventListener('click', async () => {
  const password = adminPasswordInput.value.trim();

  if (!password) {
    showFeedback('Please enter the admin password.');
    return;
  }

  try {
    const auth = btoa(`admin:${password}`);
    const res = await fetch('/download-log', {
      headers: { Authorization: `Basic ${auth}` }
    });

    if (!res.ok) {
      showFeedback('Incorrect admin password.');
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

    adminModal.style.display = 'none';
    adminPasswordInput.value = '';
  } catch (err) {
    console.error('Admin download error:', err);
    showFeedback('Could not download log.');
  }
});

adminPasswordInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') adminSubmit.click();
});

loadNames();
