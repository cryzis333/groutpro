document.getElementById('login-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.textContent = 'Вход...';
    const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
            username: document.getElementById('username').value,
            password: document.getElementById('password').value
        })
    });
    const data = res.ok ? await res.json() : null;
    if (data && data.token) {
        localStorage.setItem('admin_token', data.token);
        location.href = '/admin';
    } else {
        alert('Неверный логин или пароль');
        btn.textContent = 'Войти';
    }
};
