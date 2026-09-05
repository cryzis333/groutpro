document.getElementById('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.target.querySelector('button');
    button.textContent = 'Вход...'; button.disabled = true;
    try {
        const response = await fetch('/api/admin/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ username: document.getElementById('username').value, password: document.getElementById('password').value }) });
        if (!response.ok) throw new Error();
        location.replace('admin.html');
    } catch (_) {
        alert('Неверный логин или пароль'); button.textContent = 'Войти'; button.disabled = false;
    }
});
