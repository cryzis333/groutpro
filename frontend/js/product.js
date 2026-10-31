const money = value => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(value / 100);
// Backend limit per order line (services/checkout.rs MAX_QUANTITY_PER_ITEM)
const MAX_QTY = 100;
document.addEventListener('DOMContentLoaded', async () => {
    const params = new URLSearchParams(location.search);
    const id = params.get('id') || (location.pathname.match(/^\/product\/([0-9a-fA-F-]{36})\/?$/) || [])[1];
    if (!id) return location.href = '/shop';

    const escapeHtml = text => { const d = document.createElement('div'); d.textContent = text || ''; return d.innerHTML; };
    const readCart = () => { try { return JSON.parse(localStorage.getItem('cart') || '[]'); } catch { return []; } };

    let isRegistered = false;
    try {
        const authRes = await fetch('/api/auth/me', { credentials: 'same-origin' });
        isRegistered = authRes.ok;
    } catch { isRegistered = false; }

    try {
        const res = await fetch(`/api/products/${encodeURIComponent(id)}`);
        if (!res.ok) throw new Error('Not found');
        const p = await res.json();

        // Services are priced per пог. м / м² / ввод and need no stock; only «шт» items are counted
        const service = !!p.unit && p.unit !== 'шт';
        const byRequest = !(p.price > 0);

        document.getElementById('prod-title').textContent = p.title;
        // Tab title, description and search-engine data per product
        document.title = `${p.title} — ГраутПро`;
        const metaDesc = document.querySelector('meta[name="description"]');
        if (metaDesc) metaDesc.content = (p.description || p.title).replace(/\s+/g, ' ').slice(0, 160);
        const ld = document.createElement('script');
        ld.type = 'application/ld+json';
        ld.textContent = JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'Product',
            name: p.title,
            description: p.description || undefined,
            image: p.preview_image ? `${location.origin}/uploads/${p.preview_image}` : undefined,
            category: p.category || undefined,
            offers: {
                '@type': 'Offer',
                price: (p.price / 100).toFixed(2),
                priceCurrency: 'RUB',
                availability: service || p.stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
                url: location.href
            }
        });
        document.head.appendChild(ld);

        const unit = p.unit ? ' / ' + p.unit : '';
        const priceEl = document.getElementById('prod-price');
        const hasDiscount = p.discount_percent_bps > 0;
        const appliesNow = hasDiscount && (!p.discount_registered_only || isRegistered);
        if (appliesNow) {
            const finalPrice = Math.floor(p.price * (10000 - p.discount_percent_bps) / 10000);
            priceEl.innerHTML = `
                <span>${service ? 'от ' : ''}${money(finalPrice)}${escapeHtml(unit)}</span>
                <span class="prod-price-old">${money(p.price)}</span>
                <span class="shop-discount-badge">-${p.discount_percent_bps/100}%</span>
            `;
        } else if (hasDiscount) {
            priceEl.innerHTML = `
                <span>${service ? 'от ' : ''}${money(p.price)}${escapeHtml(unit)}</span>
                <span class="shop-discount-badge">-${p.discount_percent_bps/100}% для зарегистрированных</span>
            `;
        } else {
            priceEl.textContent = byRequest ? 'Цена по запросу' : (service ? 'от ' : '') + money(p.price) + unit;
        }

        document.getElementById('prod-desc').textContent = p.description || 'Нет описания';
        const stockEl = document.getElementById('prod-stock');
        stockEl.textContent = service
            ? 'Точный объём и стоимость определяем на объекте после замера.'
            : (p.stock > 0 ? `В наличии: ${p.stock} шт.` : 'Нет в наличии');

        const mainImg = document.getElementById('prod-main-img');
        const thumbs = document.getElementById('prod-thumbs');
        const images = p.images || [];

        if (images.length) {
            mainImg.src = '/uploads/' + encodeURIComponent(images[0]);
            mainImg.alt = p.title;
            thumbs.innerHTML = images.map((img, i) => `
                <img src="/uploads/${encodeURIComponent(img)}" class="${i === 0 ? 'active' : ''}" data-index="${i}" alt="${escapeHtml(p.title)}: фото ${i + 1}" tabindex="0" role="button" aria-pressed="${i === 0}">
            `).join('');
            const showThumb = thumb => {
                mainImg.src = thumb.getAttribute('src');
                thumbs.querySelectorAll('img').forEach(img => {
                    img.classList.toggle('active', img === thumb);
                    img.setAttribute('aria-pressed', String(img === thumb));
                });
            };
            thumbs.addEventListener('click', (event) => {
                const thumb = event.target.closest('img');
                if (thumb) showThumb(thumb);
            });
            thumbs.addEventListener('keydown', (event) => {
                const thumb = event.target.closest('img');
                if (thumb && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault();
                    showThumb(thumb);
                }
            });
        } else {
            mainImg.insertAdjacentHTML('afterend', '<div class="product-gallery-empty">Фото скоро</div>');
            mainImg.style.display = 'none';
        }

        const addBtn = document.getElementById('add-cart');
        const addBtnLabel = addBtn.innerHTML;
        if (byRequest) {
            // Цену считаем по объекту — в корзину такую позицию не кладём
            addBtn.replaceWith(Object.assign(document.createElement('a'), {
                className: 'btn btn-primary btn-block',
                href: '/#contact',
                textContent: 'Запросить расчёт'
            }));
            stockEl.textContent = 'Стоимость зависит от объекта — посчитаем после осмотра.';
            return;
        }
        const limit = service ? MAX_QTY : Math.min(p.stock, MAX_QTY);
        if (limit <= 0) {
            addBtn.disabled = true;
            addBtn.textContent = 'Нет в наличии';
            return;
        }
        let restoreTimer = null;
        const flash = (html, ms) => {
            addBtn.innerHTML = html;
            clearTimeout(restoreTimer);
            restoreTimer = setTimeout(() => { addBtn.innerHTML = addBtnLabel; }, ms);
        };
        addBtn.addEventListener('click', () => {
            const cart = readCart();
            const existing = cart.find(item => item.id === p.id);
            const inCart = existing ? existing.qty : 0;
            // Nothing is reserved until payment, so the limit is simply the current stock.
            if (inCart >= limit) {
                flash(service ? 'Максимум для одного заказа уже в корзине' : 'Весь остаток уже в корзине', 1800);
                return;
            }
            if (existing) { existing.qty++; existing.stock = p.stock; existing.unit = p.unit || null; }
            else cart.push({ id: p.id, title: p.title, price: p.price, preview: p.preview_image, qty: 1, stock: p.stock, unit: p.unit || null });
            try {
                localStorage.setItem('cart', JSON.stringify(cart));
            } catch {
                flash('Не удалось сохранить корзину в браузере', 2500);
                return;
            }
            flash('<svg class="icon icon-inline" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" ><path d="M20 6 9 17l-5-5" /></svg>Добавлено', 1500);
        });
    } catch (e) {
        // Keep the site shell (nav, footer) and show the message where the product would be
        const detail = document.querySelector('.product-detail');
        const html = '<div class="product-missing"><h1>Товар не найден</h1><a href="/shop" class="btn btn-primary">В каталог</a></div>';
        if (detail) detail.innerHTML = html;
        else document.body.insertAdjacentHTML('afterbegin', html);
        document.title = 'Товар не найден — ГраутПро';
    }
});
