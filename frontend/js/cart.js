function readCart() {
    try {
        const raw = JSON.parse(localStorage.getItem('cart') || '[]');
        if (!Array.isArray(raw)) throw new Error();
        return raw.filter(item => /^[a-f0-9-]{36}$/i.test(item.id || '') && Number.isInteger(item.qty) && item.qty > 0 && item.qty <= 100);
    } catch (_) {
        localStorage.removeItem('cart');
        return [];
    }
}
function saveCart(cart) { localStorage.setItem('cart', JSON.stringify(cart)); }
function safeImageName(value) { return typeof value === 'string' && /^[a-f0-9-]+\.(?:jpg|png|webp)$/i.test(value); }

function renderCart() {
    const cart = readCart();
    const container = document.getElementById('cart-items');
    const totalElement = document.getElementById('cart-total');
    container.replaceChildren();
    if (!cart.length) {
        const text = document.createElement('p');
        text.style.cssText = 'text-align:center;color:var(--muted);padding:40px 0';
        text.textContent = 'Корзина пуста. ';
        const link = document.createElement('a'); link.href = 'shop.html'; link.textContent = 'Перейти в магазин →'; link.style.color = 'var(--accent)';
        text.append(link); container.append(text); totalElement.textContent = '0.00 ₽'; return;
    }
    let displayedTotal = 0;
    cart.forEach((item, index) => {
        const row = document.createElement('div'); row.className = 'cart-item glass';
        if (safeImageName(item.preview)) { const image = document.createElement('img'); image.src = `/uploads/${encodeURIComponent(item.preview)}`; image.alt = String(item.title || 'Товар'); row.append(image); }
        const info = document.createElement('div'); info.className = 'cart-item-info';
        const title = document.createElement('h4'); title.textContent = String(item.title || 'Товар');
        const price = document.createElement('p'); price.style.color = 'var(--muted)'; price.textContent = `${(Number(item.price || 0) / 100).toFixed(2)} ₽ × ${item.qty}`;
        info.append(title, price); row.append(info);
        const actions = document.createElement('div'); actions.className = 'cart-item-actions';
        actions.append(actionButton('−', () => changeQty(index, -1)), document.createTextNode(String(item.qty)), actionButton('+', () => changeQty(index, 1)), actionButton('×', () => removeItem(index), 'remove'));
        row.append(actions); container.append(row); displayedTotal += Number(item.price || 0) * item.qty;
    });
    totalElement.textContent = `${(displayedTotal / 100).toFixed(2)} ₽`;
}
function actionButton(text, handler, className) { const button = document.createElement('button'); button.type = 'button'; button.textContent = text; if (className) button.className = className; button.addEventListener('click', handler); return button; }
function changeQty(index, delta) { const cart = readCart(); if (!cart[index]) return; cart[index].qty += delta; if (cart[index].qty <= 0) cart.splice(index, 1); else cart[index].qty = Math.min(cart[index].qty, 100); saveCart(cart); renderCart(); }
function removeItem(index) { const cart = readCart(); cart.splice(index, 1); saveCart(cart); renderCart(); }

document.getElementById('checkout-form').addEventListener('submit', async event => {
    event.preventDefault();
    const cart = readCart(); if (!cart.length) return alert('Корзина пуста');
    const button = event.target.querySelector('button[type="submit"]'); const original = button.textContent; button.textContent = 'Обработка...'; button.disabled = true;
    try {
        const response = await fetch('/api/payments/create', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ customer_name: document.getElementById('name').value, customer_phone: document.getElementById('phone').value, customer_email: document.getElementById('email').value || null, customer_address: document.getElementById('address').value || null, items: cart.map(item => ({product_id:item.id, quantity:item.qty})) }) });
        const payment = await response.json(); if (!response.ok) throw new Error(payment.error || 'Ошибка сервера');
        const confirmationUrl = payment.confirmation && payment.confirmation.confirmation_url;
        if (!confirmationUrl || new URL(confirmationUrl).protocol !== 'https:') throw new Error('Не получена безопасная ссылка на оплату');
        localStorage.removeItem('cart'); location.assign(confirmationUrl);
    } catch (error) { alert(`Ошибка оформления: ${error.message}`); button.textContent = original; button.disabled = false; }
});
renderCart();
