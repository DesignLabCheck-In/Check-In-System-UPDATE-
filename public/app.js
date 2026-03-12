// Client-side access password
const REQUIRED_PASSWORD = "WelcomeDL";

function showAccessModal() {
  const stored = localStorage.getItem('dlAuthorized');
  if (stored === 'true') {
    document.getElementById('access-modal').style.display = 'none';
    return;
  }
  document.getElementById('access-submit').addEventListener('click', () => {
    const input = document.getElementById('access-password').value;
    if (input === REQUIRED_PASSWORD) {
      localStorage.setItem('dlAuthorized', 'true');
      document.getElementById('access-modal').style.display = 'none';
    } else {
      alert("Access denied.");
      document.body.innerHTML = "";
    }
  });
}

async function loadNames() {
  const res = await fetch('/names');
  const data = await res.json();
  const select = document.getElementById('name-select');
  data.forEach(name => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    select.appendChild(option);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  showAccessModal();
  loadNames();

  // Check-In
  const form = document.getElementById('checkin-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('name-select').value;
    const team = document.getElementById('team-select').value;
    if (!name || !team) { alert("Please select both name and team."); return; }

    const res = await fetch('/checkin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, team })
    });

    const data = await res.json();
    const msgBox = document.getElementById('checkin-message');
    const modal = document.getElementById('checkin-modal');

    // Map new server statuses to the SAME user-facing messages as before
    switch (data.status) {
      case 'checkin-ontime':
        msgBox.textContent = "Check-in successful 🎉! You are on time 💚";
        break;
      case 'checkin-late':
        msgBox.textContent = "You are late! 😵‍💫 Please let your coordinator know!";
        break;
      case 'checkin-weekend':
        msgBox.textContent = "You do not need to check-in during the weekend 😉";
        break;
      default:
        // Fallback for unexpected statuses
        msgBox.textContent = "Check-in status: " + (data.status ?? 'unknown');
    }
    modal.style.display = 'flex';
  });

  // Check-Out
  const checkoutBtn = document.getElementById('checkout-btn');
  checkoutBtn.addEventListener('click', async () => {
    const name = document.getElementById('name-select').value;
    const team = document.getElementById('team-select').value;
    if (!name || !team) { alert("Please select both name and team."); return; }

    try {
      const res = await fetch('/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, team })
      });
      const data = await res.json();
      const msgBox = document.getElementById('checkin-message');
      const modal = document.getElementById('checkin-modal');

      if (res.ok) {
        msgBox.textContent = `Checked out at ${data.at} ✅`;
      } else {
        msgBox.textContent = data.error || 'Checkout failed';
      }
      modal.style.display = 'flex';
    } catch (e) {
      alert('Network error during checkout');
    }
  });

  // Close feedback modal
  document.getElementById('checkin-close').addEventListener('click', () => {
    document.getElementById('checkin-modal').style.display = 'none';
  });

  // Admin download
  document.getElementById('admin-download').addEventListener('click', () => {
    document.getElementById('admin-modal').style.display = 'flex';
    document.getElementById('admin-password').value = '';
    document.getElementById('admin-password').focus();
  });

  document.getElementById('admin-submit').addEventListener('click', async () => {
    const password = document.getElementById('admin-password').value.trim();
    if (!password) return;

    const response = await fetch('/download-log', {
      headers: { 'Authorization': 'Basic ' + btoa(`admin:${password}`) }
    });

    if (!response.ok) {
      alert('Authentication failed or log not found.');
      return;
    }

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'checkins.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
    document.getElementById('admin-modal').style.display = 'none';
  });

  document.getElementById('admin-cancel').addEventListener('click', () => {
    document.getElementById('admin-modal').style.display = 'none';
  });
});
