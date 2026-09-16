(() => {
  const guest = document.getElementById('account-guest');
  const profile = document.getElementById('account-profile');
  const message = document.getElementById('account-message');

  function showMessage(text, isError = false) {
    message.textContent = text;
    message.classList.toggle('is-error', isError);
  }

  async function request(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options
    });
    const data = response.status === 204 ? null : await response.json();
    if (!response.ok) throw new Error(data?.error || 'Не удалось выполнить запрос');
    return data;
  }

  async function loadProfile() {
    try {
      const user = await request('/api/auth/me');
      guest.hidden = true;
      profile.hidden = false;
      document.getElementById('profile-name').textContent = user.display_name;
      document.getElementById('profile-email').textContent = user.email;
      const orders = await request('/api/account/orders');
      document.getElementById('account-orders').innerHTML = orders.length ? orders.map(order => `
        <article class="account-order">
          <strong>${escapeHtml(order.public_number)}</strong>
          <span>${formatStatus(order.status)}</span>
          <span>${(order.total_amount / 100).toFixed(2)} ₽</span>
          <time>${new Date(order.created_at).toLocaleDateString('ru-RU')}</time>
        </article>`).join('') : '<p>У вас пока нет заказов.</p>';
    } catch {
      guest.hidden = false;
      profile.hidden = true;
    }
  }

  document.getElementById('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: document.getElementById('login-email').value, password: document.getElementById('login-password').value }) });
      await loadProfile();
    } catch (error) { showMessage(error.message, true); }
  });

  document.getElementById('register-form').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      await request('/api/auth/register', { method: 'POST', body: JSON.stringify({ name: document.getElementById('register-name').value, email: document.getElementById('register-email').value, password: document.getElementById('register-password').value }) });
      await loadProfile();
    } catch (error) { showMessage(error.message, true); }
  });

  document.getElementById('logout-button').addEventListener('click', async () => {
    await request('/api/auth/logout', { method: 'POST' });
    location.reload();
  });

  function escapeHtml(value) { const el = document.createElement('div'); el.textContent = value || ''; return el.innerHTML; }
  function formatStatus(status) { return ({ pending_payment: 'Ожидает оплаты', paid: 'Оплачен', processing: 'В обработке', fulfilled: 'Выполнен', cancelled: 'Отменён' })[status] || status; }
  loadProfile();
})();
