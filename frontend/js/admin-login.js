'use strict';
// Вход в админку. Логин сервер сравнивает как есть, поэтому только убираем
// пробелы по краям; пароль отправляем без изменений.
(() => {
    const form = document.getElementById('login-form');
    const username = document.getElementById('username');
    const password = document.getElementById('password');
    const message = document.getElementById('login-message');
    const button = form.querySelector('button[type="submit"]');
    const buttonText = button.textContent;

    function showMessage(text, isError = true, field = null) {
        message.textContent = text;
        message.classList.toggle('is-error', isError);
        [username, password].forEach(input => input.removeAttribute('aria-invalid'));
        if (field) {
            field.setAttribute('aria-invalid', 'true');
            field.focus();
        }
    }

    function errorText(res, data) {
        const text = data && typeof data.error === 'string' ? data.error : '';
        if (res.status === 401) return 'Неверный логин или пароль';
        if (res.status === 429) return 'Слишком много попыток. Подождите минуту и попробуйте снова.';
        if (/[а-яё]/i.test(text)) return text;
        if (res.status >= 500) return `Сервер временно недоступен (код ${res.status}). Попробуйте позже.`;
        return `Не удалось войти (код ${res.status}). Обновите страницу и попробуйте снова.`;
    }

    if (new URLSearchParams(location.search).has('expired')) {
        showMessage('Сессия истекла — войдите снова.', false);
    }

    [username, password].forEach(input => input.addEventListener('input', () => {
        input.removeAttribute('aria-invalid');
        if (message.classList.contains('is-error')) message.textContent = '';
    }));

    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (button.disabled) return;
        const login = username.value.trim();
        if (!login) { showMessage('Введите логин', true, username); return; }
        if (!password.value) { showMessage('Введите пароль', true, password); return; }

        showMessage('');
        button.disabled = true;
        button.textContent = 'Входим…';
        let redirecting = false;
        try {
            const res = await fetch('/api/admin/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: login, password: password.value })
            });
            let data = null;
            try { data = await res.json(); } catch (e) { /* не JSON — ниже покажем код ответа */ }
            if (!res.ok || !data || !data.token) {
                showMessage(res.ok ? 'Сервер ответил непонятно. Попробуйте ещё раз.' : errorText(res, data), true, res.status === 401 ? password : null);
                return;
            }
            try {
                localStorage.setItem('admin_token', data.token);
            } catch (e) {
                showMessage('Браузер запрещает сохранять данные сайта. Разрешите их для этого адреса или выйдите из режима инкогнито.');
                return;
            }
            redirecting = true;
            location.replace('/admin');
        } catch (e) {
            showMessage('Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.');
        } finally {
            if (!redirecting) {
                button.disabled = false;
                button.textContent = buttonText;
            }
        }
    });
})();
