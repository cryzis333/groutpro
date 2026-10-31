const money = value => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(value / 100);
const ICON_ARROW_RIGHT = '<svg class="icon icon-after" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" ><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></svg>';
const ICON_X = '<svg class="icon" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" ><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>';
const ICON_IMAGE = '<svg class="icon" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" ><rect width="18" height="18" x="3" y="3" rx="2" ry="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" /></svg>';
// Backend limit per order line (services/checkout.rs MAX_QUANTITY_PER_ITEM)
const MAX_QTY = 100;

// The cart in localStorage is only a snapshot from the moment of adding.
// Every render refreshes title/price/stock from the server, so the buyer sees
// current data; nothing is reserved until payment is confirmed.
let cartItems = [];

function readCart() {
    try { return JSON.parse(localStorage.getItem('cart') || '[]'); } catch { return []; }
}

function saveCart() {
    try {
        localStorage.setItem('cart', JSON.stringify(cartItems.map(({ id, title, price, preview, qty, stock, unit }) =>
            ({ id, title, price, preview, qty, stock, unit }))));
    } catch {
        // Storage blocked: the cart still works for this page view.
    }
}

function clearStoredCart() {
    try { localStorage.removeItem('cart'); } catch {}
}

function unitPrice(product, isRegistered) {
    const applies = product.discount_percent_bps > 0 && (!product.discount_registered_only || isRegistered);
    return applies ? Math.floor(product.price * (10000 - product.discount_percent_bps) / 10000) : product.price;
}

// Services (пог. м, м², ввод…) are not counted in stock; only «шт» items are
function tracksStock(item) {
    return !item.unit || item.unit === 'шт';
}

function maxQty(item) {
    return tracksStock(item) && typeof item.stock === 'number' ? Math.min(item.stock, MAX_QTY) : MAX_QTY;
}

async function refreshCart() {
    const snapshot = readCart();
    if (!cartItems.length) { cartItems = snapshot; renderCart(); }   // instant first paint
    if (!snapshot.length) return;
    let isRegistered = false;
    try { isRegistered = (await fetch('/api/auth/me', { credentials: 'same-origin' })).ok; } catch {}

    cartItems = await Promise.all(snapshot.map(async item => {
        try {
            const res = await fetch(`/api/products/${encodeURIComponent(item.id)}`);
            if (res.status === 404) return { ...item, gone: true };
            if (!res.ok) return item;               // server hiccup: keep the snapshot
            const p = await res.json();
            const fresh = { ...item, title: p.title, preview: p.preview_image, stock: p.stock, unit: p.unit || null, price: unitPrice(p, isRegistered), gone: false, reduced: false };
            const limit = maxQty(fresh);
            if (limit > 0 && item.qty > limit) { fresh.qty = limit; fresh.reduced = true; }
            return fresh;
        } catch {
            return item;                             // offline: keep the snapshot
        }
    }));
    saveCart();
    renderCart();
}

function isBlocked(item) {
    return item.gone || (tracksStock(item) && item.stock === 0);
}

function thumbHtml(item) {
    if (!item.preview) return `<div class="cart-item-thumb cart-item-thumb--empty" aria-hidden="true">${ICON_IMAGE}</div>`;
    return `<img class="cart-item-thumb" src="/uploads/${encodeURIComponent(item.preview)}" alt="${escapeHtml(item.title)}" loading="lazy">`;
}

function renderCart() {
    const container = document.getElementById('cart-items');
    const totalEl = document.getElementById('cart-total');
    const form = document.getElementById('checkout-form');
    if (!cartItems.length) {
        container.innerHTML = `<p class="cart-empty">Корзина пуста. <a href="/shop" class="inline-link cart-empty-link">Перейти в магазин ${ICON_ARROW_RIGHT}</a></p>`;
        if (form) form.hidden = true;
        totalEl.textContent = money(0);
        return;
    }
    if (form) form.hidden = false;
    let total = 0;
    container.innerHTML = cartItems.map((item, i) => {
        const blocked = isBlocked(item);
        if (!blocked) total += item.price * item.qty;
        const atMax = item.qty >= maxQty(item);
        let note = '';
        if (item.gone) note = '<p class="cart-item-note is-error">Товар снят с продажи — удалите его из корзины</p>';
        else if (blocked) note = '<p class="cart-item-note is-error">Закончился на складе — удалите его из корзины</p>';
        else if (item.reduced) note = tracksStock(item) && item.stock < MAX_QTY
            ? `<p class="cart-item-note">На складе только ${item.stock} шт. — количество уменьшено</p>`
            : `<p class="cart-item-note">В одном заказе не больше ${MAX_QTY} — количество уменьшено</p>`;
        else if (atMax && tracksStock(item) && item.stock <= MAX_QTY) note = '<p class="cart-item-note">Это весь остаток на складе</p>';
        return `
            <div class="cart-item glass${blocked ? ' is-unavailable' : ''}">
                ${thumbHtml(item)}
                <div class="cart-item-info">
                    <h4>${escapeHtml(item.title)}</h4>
                    <p class="cart-item-price">${money(item.price)} × ${item.qty}</p>
                    ${note}
                </div>
                <div class="cart-item-actions">
                    <button type="button" data-action="dec" data-index="${i}" aria-label="Меньше" ${blocked ? 'disabled' : ''}>−</button>
                    <span class="cart-item-qty">${item.qty}</span>
                    <button type="button" data-action="inc" data-index="${i}" aria-label="Больше" ${blocked || atMax ? 'disabled' : ''}>+</button>
                    <button type="button" data-action="remove" data-index="${i}" class="remove" aria-label="Удалить из корзины">${ICON_X}</button>
                </div>
            </div>
        `;
    }).join('');
    // A missing photo falls back to the neutral placeholder instead of a broken image
    container.querySelectorAll('img.cart-item-thumb').forEach(img => {
        img.addEventListener('error', () => {
            const placeholder = document.createElement('div');
            placeholder.className = 'cart-item-thumb cart-item-thumb--empty';
            placeholder.setAttribute('aria-hidden', 'true');
            placeholder.innerHTML = ICON_IMAGE;
            img.replaceWith(placeholder);
        }, { once: true });
    });
    totalEl.textContent = money(total);
}

function changeQty(i, delta) {
    const item = cartItems[i];
    if (!item || isBlocked(item)) return;
    if (delta > 0 && item.qty >= maxQty(item)) return;
    item.qty += delta;
    item.reduced = false;
    if (item.qty <= 0) cartItems.splice(i, 1);
    saveCart();
    renderCart();
}

function removeItem(i) {
    cartItems.splice(i, 1);
    saveCart();
    renderCart();
}

document.getElementById('cart-items').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-action]');
    if (!btn || btn.disabled) return;
    const i = Number(btn.dataset.index);
    if (btn.dataset.action === 'inc') changeQty(i, 1);
    else if (btn.dataset.action === 'dec') changeQty(i, -1);
    else if (btn.dataset.action === 'remove') removeItem(i);
});

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
}

async function prefillFromProfile() {
    try {
        const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
        if (!res.ok) return;
        const user = await res.json();
        const nameEl = document.getElementById('name');
        const phoneEl = document.getElementById('phone');
        const emailEl = document.getElementById('email');
        const addressEl = document.getElementById('address');
        if (nameEl && !nameEl.value) nameEl.value = user.display_name || '';
        if (phoneEl && !phoneEl.value) phoneEl.value = user.phone || '';
        if (emailEl && !emailEl.value) emailEl.value = user.email || '';
        if (addressEl && !addressEl.value) addressEl.value = user.address || '';
    } catch {
        // Not logged in — leave the form for manual entry.
    }
}

function checkoutMessage(text) {
    const form = document.getElementById('checkout-form');
    let el = document.getElementById('checkout-message');
    if (!el) {
        el = document.createElement('p');
        el.id = 'checkout-message';
        el.className = 'cart-item-note is-error checkout-message';
        el.setAttribute('role', 'alert');
        form.querySelector('button[type="submit"]').after(el);
    }
    el.textContent = text;
    el.hidden = !text;
}

// The checkout form is hidden once the cart is empty, so the confirmation goes where the cart was
function showOrderDone(orderNumber) {
    const container = document.getElementById('cart-items');
    container.innerHTML = `
        <div class="cart-done glass" role="status" tabindex="-1">
            <p>Заявка на счёт принята, номер <strong>${escapeHtml(String(orderNumber || ''))}</strong>. Счёт и договор пришлём на указанную почту в рабочее время.</p>
            <p><a href="/shop" class="inline-link cart-empty-link">Перейти в магазин ${ICON_ARROW_RIGHT}</a></p>
        </div>`;
    const done = container.querySelector('.cart-done');
    done.focus({ preventScroll: true });
    done.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

document.getElementById('checkout-form').onsubmit = async (e) => {
    e.preventDefault();
    checkoutMessage('');
    if (!cartItems.length) return checkoutMessage('Корзина пуста');
    if (cartItems.some(isBlocked)) return checkoutMessage('В корзине есть товары, которых нет в наличии — удалите их, чтобы оформить заказ.');

    const btn = e.target.querySelector('button[type="submit"]');
    btn.textContent = 'Обработка...';
    btn.disabled = true;

    const invoice = paymentMethod() === 'invoice';
    const data = {
        customer_name: document.getElementById('name').value,
        customer_phone: document.getElementById('phone').value,
        customer_email: document.getElementById('email').value || null,
        customer_address: document.getElementById('address').value || null,
        items: cartItems.map(c => ({ product_id: c.id, quantity: c.qty })),
        consent: document.getElementById('checkout-consent').checked,
        company_name: invoice ? document.getElementById('company-name').value.trim() : null,
        company_inn: invoice ? document.getElementById('company-inn').value.replace(/\D/g, '') : null,
        website: document.getElementById('checkout-website').value
    };

    try {
        const res = await fetch(invoice ? '/api/orders/invoice' : '/api/payments/create', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify(data)
        });
        const payment = await res.json().catch(() => ({}));
        if (!res.ok || payment.error) throw new Error(payment.error || 'Не удалось оформить заказ');
        if (invoice) {
            clearStoredCart();
            cartItems = [];
            renderCart();
            checkoutMessage('');
            btn.disabled = false;
            syncPaymentMethod();
            showOrderDone(payment.order);
            return;
        }
        const confirmUrl = payment.payment?.confirmation?.confirmation_url || payment.confirmation?.confirmation_url;
        if (!confirmUrl) throw new Error('Не получена ссылка на оплату');
        clearStoredCart();
        location.href = confirmUrl;
    } catch (err) {
        checkoutMessage(err.message === 'Failed to fetch' ? 'Нет соединения с сервером, попробуйте ещё раз' : err.message);
        btn.disabled = false;
        syncPaymentMethod();
        refreshCart();   // stock may have changed since the page was opened
    }
};

// Способ оплаты: онлайн через СБП или счёт для юрлица (оплата вне сайта)
function paymentMethod() {
    const picked = document.querySelector('input[name="pay-method"]:checked');
    return picked ? picked.value : 'sbp';
}

function syncPaymentMethod() {
    const invoice = paymentMethod() === 'invoice';
    const fields = document.getElementById('company-fields');
    if (fields) fields.hidden = !invoice;
    const btn = document.querySelector('#checkout-form button[type="submit"]');
    if (btn && !btn.disabled) btn.textContent = invoice ? 'Запросить счёт' : 'Оплатить через СБП';
}

document.querySelectorAll('input[name="pay-method"]').forEach(input => input.addEventListener('change', syncPaymentMethod));
syncPaymentMethod();

refreshCart();
prefillFromProfile();
