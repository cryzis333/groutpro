const money = value => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(value / 100);
document.addEventListener('DOMContentLoaded', async () => {
    const params = new URLSearchParams(location.search);
    const id = params.get('id') || (location.pathname.match(/^\/product\/([0-9a-fA-F-]{36})$/) || [])[1];
    if (!id) return location.href = '/shop';

    let isRegistered = false;
    try {
        const authRes = await fetch('/api/auth/me', { credentials: 'same-origin' });
        isRegistered = authRes.ok;
    } catch { isRegistered = false; }

    try {
        const res = await fetch(`/api/products/${id}`);
        if (!res.ok) throw new Error('Not found');
        const p = await res.json();

        if (p.category) {
            try {
                fetch('/api/analytics/view', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: location.pathname, category: p.category }),
                    keepalive: true
                }).catch(() => {});
            } catch (e) {}
        }

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
                availability: p.stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
                url: location.href
            }
        });
        document.head.appendChild(ld);

        const unit = p.unit ? ' / ' + p.unit : '';
        const service = p.unit && p.unit !== 'шт';
        const priceEl = document.getElementById('prod-price');
        const byRequest = !(p.price > 0);
        const hasDiscount = p.discount_percent_bps > 0;
        const appliesNow = hasDiscount && (!p.discount_registered_only || isRegistered);
        if (appliesNow) {
            const finalPrice = Math.floor(p.price * (10000 - p.discount_percent_bps) / 10000);
            priceEl.innerHTML = `
                <span>${service ? 'от ' : ''}${money(finalPrice)}${unit}</span>
                <span class="prod-price-old">${money(p.price)}</span>
                <span class="shop-discount-badge">-${p.discount_percent_bps/100}%</span>
            `;
        } else if (hasDiscount) {
            priceEl.innerHTML = `
                <span>${service ? 'от ' : ''}${money(p.price)}${unit}</span>
                <span class="shop-discount-badge">-${p.discount_percent_bps/100}% для зарегистрированных</span>
            `;
        } else {
            priceEl.textContent = byRequest ? 'Цена по запросу' : (service ? 'от ' : '') + money(p.price) + unit;
        }

        document.getElementById('prod-desc').textContent = p.description || 'Нет описания';
        document.getElementById('prod-stock').textContent = service
            ? 'Точный объём и стоимость определяем на объекте после замера.'
            : (p.stock > 0 ? `В наличии: ${p.stock} шт.` : 'Нет в наличии');

        const mainImg = document.getElementById('prod-main-img');
        const thumbs = document.getElementById('prod-thumbs');
        const images = p.images || [];

        if (images.length) {
            mainImg.src = '/uploads/' + images[0];
            mainImg.alt = p.title;
            thumbs.innerHTML = images.map((img, i) => `
                <img src="/uploads/${img}" class="${i===0?'active':''}" onclick="setMain('${img}',this)" alt="${p.title}: фото ${i+1}" tabindex="0" role="button">
            `).join('');
        } else {
            mainImg.insertAdjacentHTML('afterend', '<div class="product-gallery-empty">Фото скоро</div>');
            mainImg.style.display = 'none';
        }

        thumbs.addEventListener('keydown', (event) => {
            const thumb = event.target.closest('img');
            if (thumb && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault();
                thumb.click();
            }
        });

        window.setMain = (src, el) => {
            mainImg.src = '/uploads/' + src;
            thumbs.querySelectorAll('img').forEach(img => img.classList.remove('active'));
            el.classList.add('active');
        };

        const addBtn = document.getElementById('add-cart');
        const addBtnLabel = addBtn.innerHTML;
        if (byRequest) {
            // Цену считаем по объекту — в корзину такую позицию не кладём
            addBtn.replaceWith(Object.assign(document.createElement('a'), {
                className: 'btn btn-primary',
                href: '/#contact',
                textContent: 'Запросить расчёт',
                style: 'width:100%;justify-content:center'
            }));
            document.getElementById('prod-stock').textContent = 'Стоимость зависит от объекта — посчитаем после осмотра.';
            return;
        }
        if (p.stock <= 0) {
            addBtn.disabled = true;
            addBtn.textContent = 'Нет в наличии';
        }
        addBtn.onclick = () => {
            const cart = JSON.parse(localStorage.getItem('cart') || '[]');
            const existing = cart.find(item => item.id === p.id);
            const inCart = existing ? existing.qty : 0;
            // Nothing is reserved until payment, so the limit is simply the current stock.
            if (inCart >= p.stock) {
                addBtn.textContent = inCart ? 'Весь остаток уже в корзине' : 'Нет в наличии';
                setTimeout(() => addBtn.innerHTML = addBtnLabel, 1800);
                return;
            }
            if (existing) { existing.qty++; existing.stock = p.stock; }
            else cart.push({ id: p.id, title: p.title, price: p.price, preview: p.preview_image, qty: 1, stock: p.stock });
            localStorage.setItem('cart', JSON.stringify(cart));
            addBtn.innerHTML = '<svg class="icon icon-inline" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" ><path d="M20 6 9 17l-5-5" /></svg>Добавлено';
            setTimeout(() => addBtn.innerHTML = addBtnLabel, 1500);
        };
    } catch (e) {
        document.body.innerHTML = '<div style="text-align:center;padding:120px 20px"><h2 style="margin-bottom:24px">Товар не найден</h2><a href="/shop" class="btn btn-primary">В каталог</a></div>';
    }
});
