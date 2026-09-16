function renderCart() {
    const cart = JSON.parse(localStorage.getItem('cart') || '[]');
    const container = document.getElementById('cart-items');
    const totalEl = document.getElementById('cart-total');
    if (!cart.length) {
        container.innerHTML = '<p style="text-align:center;color:var(--muted);padding:40px 0">Корзина пуста. <a href="/shop" style="color:var(--accent)">Перейти в магазин →</a></p>';
        totalEl.textContent = '0.00 ₽';
        return;
    }
    let total = 0;
    container.innerHTML = cart.map((item, i) => {
        total += item.price * item.qty;
        return `
            <div class="cart-item glass">
                <img src="/uploads/${item.preview || ''}" alt="" onerror="this.style.display='none'">
                <div class="cart-item-info">
                    <h4>${escapeHtml(item.title)}</h4>
                    <p style="color:var(--muted)">${(item.price/100).toFixed(2)} ₽ × ${item.qty}</p>
                </div>
                <div class="cart-item-actions">
                    <button onclick="changeQty(${i}, -1)">−</button>
                    <span style="min-width:24px;text-align:center;font-weight:700">${item.qty}</span>
                    <button onclick="changeQty(${i}, 1)">+</button>
                    <button onclick="removeItem(${i})" class="remove">×</button>
                </div>
            </div>
        `;
    }).join('');
    totalEl.textContent = (total/100).toFixed(2) + ' ₽';
}

window.changeQty = (i, delta) => {
    const cart = JSON.parse(localStorage.getItem('cart') || '[]');
    cart[i].qty += delta;
    if (cart[i].qty <= 0) cart.splice(i, 1);
    localStorage.setItem('cart', JSON.stringify(cart));
    renderCart();
};

window.removeItem = (i) => {
    const cart = JSON.parse(localStorage.getItem('cart') || '[]');
    cart.splice(i, 1);
    localStorage.setItem('cart', JSON.stringify(cart));
    renderCart();
};

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

document.getElementById('checkout-form').onsubmit = async (e) => {
    e.preventDefault();
    const cart = JSON.parse(localStorage.getItem('cart') || '[]');
    if (!cart.length) return alert('Корзина пуста');

    const btn = e.target.querySelector('button[type="submit"]');
    const originalText = btn.textContent;
    btn.textContent = 'Обработка...';
    btn.disabled = true;

    const data = {
        customer_name: document.getElementById('name').value,
        customer_phone: document.getElementById('phone').value,
        customer_email: document.getElementById('email').value || null,
        customer_address: document.getElementById('address').value || null,
        items: cart.map(c => ({ product_id: c.id, quantity: c.qty }))
    };

    try {
        const res = await fetch('/api/payments/create', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify(data)
        });
        const payment = await res.json();
        if (payment.error) throw new Error(payment.error);
        const confirmUrl = payment.payment?.confirmation?.confirmation_url || payment.confirmation?.confirmation_url;
        if (confirmUrl) {
            localStorage.removeItem('cart');
            location.href = confirmUrl;
        } else {
            throw new Error('Не получена ссылка на оплату');
        }
    } catch (err) {
        alert('Ошибка оформления: ' + err.message);
        btn.textContent = originalText;
        btn.disabled = false;
    }
};

renderCart();
