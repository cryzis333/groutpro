(() => {
  const guest = document.getElementById('account-guest');
  const profile = document.getElementById('account-profile');
  const message = document.getElementById('account-message');
  const profileMessage = document.getElementById('profile-message');
  const ordersBox = document.getElementById('account-orders');

  function showMessage(text, isError = false) {
    message.textContent = text;
    message.classList.toggle('is-error', isError);
  }

  function showProfileMessage(text, isError = false) {
    profileMessage.textContent = text;
    profileMessage.classList.toggle('is-error', isError);
  }

  async function request(url, options = {}) {
    let response;
    try {
      response = await fetch(url, {
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        ...options
      });
    } catch {
      throw new Error('Нет соединения с сервером, попробуйте ещё раз');
    }
    // A proxy error page is HTML, not JSON: never show a parser error to the visitor
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(data?.error || 'Не удалось выполнить запрос');
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function greetingWord() {
    const hour = new Date().getHours();
    if (hour < 5) return 'Доброй ночи';
    if (hour < 12) return 'Доброе утро';
    if (hour < 18) return 'Добрый день';
    return 'Добрый вечер';
  }

  function renderOrders(orders) {
    ordersBox.innerHTML = orders.length ? orders.map((order, index) => `
        <article class="account-order" style="animation-delay:${(index * 0.06).toFixed(2)}s">
          <strong>${escapeHtml(order.public_number)}</strong>
          <span class="account-order-status account-order-status--${escapeHtml(order.status)}">${escapeHtml(formatStatus(order.status))}</span>
          <span>${(order.total_amount / 100).toFixed(2)} ₽</span>
          <time datetime="${escapeHtml(order.created_at)}">${new Date(order.created_at).toLocaleDateString('ru-RU')}</time>
        </article>`).join('') : '<p>У вас пока нет заказов. <a href="/shop">Загляните в каталог <svg class="icon icon-after" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" ><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></svg></a></p>';
  }

  async function loadProfile() {
    let user;
    try {
      user = await request('/api/auth/me');
    } catch {
      guest.hidden = false;
      profile.hidden = true;
      return;
    }
    guest.hidden = true;
    profile.hidden = false;
    showMessage('');
    document.getElementById('account-greeting').textContent = greetingWord() + ',';
    document.getElementById('profile-name').textContent = user.display_name;
    document.getElementById('profile-email').textContent = user.email;
    document.getElementById('account-avatar').textContent = (user.display_name || '?').trim().charAt(0);
    document.getElementById('profile-form-name').value = user.display_name || '';
    document.getElementById('profile-form-phone').value = user.phone || '';
    document.getElementById('profile-form-address').value = user.address || '';
    // The visitor is signed in even if the order history fails to load
    try {
      renderOrders(await request('/api/account/orders'));
    } catch (error) {
      if (error.status === 401) { guest.hidden = false; profile.hidden = true; return; }
      ordersBox.innerHTML = '<p class="account-message is-error">Не удалось загрузить заказы. Обновите страницу чуть позже.</p>';
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
      await request('/api/auth/register', { method: 'POST', body: JSON.stringify({
        name: document.getElementById('register-name').value,
        email: document.getElementById('register-email').value,
        password: document.getElementById('register-password').value,
        consent: document.getElementById('register-consent').checked,
        website: document.getElementById('register-website').value
      }) });
      await loadProfile();
    } catch (error) { showMessage(error.message, true); }
  });

  document.getElementById('profile-form').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      await request('/api/account/profile', { method: 'PATCH', body: JSON.stringify({
        display_name: document.getElementById('profile-form-name').value,
        phone: document.getElementById('profile-form-phone').value,
        address: document.getElementById('profile-form-address').value
      }) });
      document.getElementById('profile-name').textContent = document.getElementById('profile-form-name').value;
      document.getElementById('account-avatar').textContent = (document.getElementById('profile-form-name').value || '?').trim().charAt(0);
      showProfileMessage('Сохранено — теперь эти данные будут подставляться при оформлении заказа.');
    } catch (error) { showProfileMessage(error.message, true); }
  });

  document.getElementById('logout-button').addEventListener('click', async () => {
    try {
      await request('/api/auth/logout', { method: 'POST' });
    } catch {
      // The session cookie may already be gone — reloading shows the real state either way.
    }
    location.reload();
  });

  function escapeHtml(value) { const el = document.createElement('div'); el.textContent = value || ''; return el.innerHTML; }
  function formatStatus(status) { return ({ pending_payment: 'Ожидает оплаты', paid: 'Оплачен', processing: 'В обработке', fulfilled: 'Выполнен', cancelled: 'Отменён' })[status] || status; }

  // Pointer effects only for a mouse/trackpad and when motion is welcome
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (finePointer && !reduceMotion) {
    // Cursor-tracking spotlight glow on the login/profile cards.
    document.querySelectorAll('.account-shell').forEach(shell => {
      shell.addEventListener('pointermove', event => {
        const rect = shell.getBoundingClientRect();
        shell.style.setProperty('--spot-x', `${event.clientX - rect.left}px`);
        shell.style.setProperty('--spot-y', `${event.clientY - rect.top}px`);
        shell.classList.add('is-glowing');
      });
      shell.addEventListener('pointerleave', () => shell.classList.remove('is-glowing'));
    });

    // Magnetic buttons: nudge toward the cursor within their own box.
    document.querySelectorAll('.account-shell .btn').forEach(btn => {
      btn.addEventListener('pointermove', event => {
        const rect = btn.getBoundingClientRect();
        const x = event.clientX - rect.left - rect.width / 2;
        const y = event.clientY - rect.top - rect.height / 2;
        btn.style.transform = `translate(${x * 0.25}px, ${y * 0.35}px)`;
      });
      btn.addEventListener('pointerleave', () => { btn.style.transform = ''; });
    });

    // Avatar tilts toward the cursor in 3D, on top of its own spinning ring.
    const avatarEl = document.getElementById('account-avatar');
    if (avatarEl) {
      avatarEl.addEventListener('pointermove', event => {
        const rect = avatarEl.getBoundingClientRect();
        const x = (event.clientX - rect.left - rect.width / 2) / (rect.width / 2);
        const y = (event.clientY - rect.top - rect.height / 2) / (rect.height / 2);
        avatarEl.style.transform = `perspective(300px) rotateY(${x * 22}deg) rotateX(${-y * 22}deg) scale(1.12)`;
      });
      avatarEl.addEventListener('pointerleave', () => { avatarEl.style.transform = ''; });
    }
  }

  loadProfile();
})();
