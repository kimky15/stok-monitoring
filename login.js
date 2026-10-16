const form = document.getElementById('formLogin');
const err = document.getElementById('errLogin');
const btn = document.getElementById('btnLogin');

// Jika sudah login, langsung ke halaman utama
fetch('/api/me').then((r) => {
  if (r.ok) location.replace('/');
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.textContent = '';
  btn.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Gagal masuk');
    // Wait a moment for the session cookie to be set, then verify `/api/me`
    // to avoid a redirect loop if the cookie hasn't propagated yet.
    await new Promise((r) => setTimeout(r, 150));
    const me = await fetch('/api/me');
    if (me.ok) return location.replace('/');
    // fallback: still try to go to root (server will redirect appropriately)
    location.replace('/');
  } catch (ex) {
    err.textContent = ex.message;
    form.password.value = '';
    form.password.focus();
  } finally {
    btn.disabled = false;
  }
});
