const form = document.getElementById('contact-form');
const statusElement = document.getElementById('contact-status');
form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    statusElement.textContent = 'Отправляем заявку…';
    const values = Object.fromEntries(new FormData(form));
    try {
        const response = await fetch('/api/contact', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(values) });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.error || 'Не удалось отправить заявку');
        form.reset();
        statusElement.textContent = 'Заявка принята. Мы свяжемся с вами.';
    } catch (error) {
        statusElement.textContent = `${error.message}. Позвоните нам: 8 905 405-31-33.`;
    } finally { button.disabled = false; }
});
