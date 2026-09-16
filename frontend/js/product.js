document.addEventListener('DOMContentLoaded', async () => {
    const pathId = location.pathname.match(/^\/product\/([a-f0-9-]{36})$/i)?.[1];
    const id = pathId || new URLSearchParams(location.search).get('id');
    if (!/^[a-f0-9-]{36}$/i.test(id || '')) return location.replace('/shop');
    try {
        const res = await fetch(`/api/products/${id}`);
        if (!res.ok) throw new Error('Not found');
        const p = await res.json();

        document.getElementById('prod-title').textContent = p.title;
        document.getElementById('prod-price').textContent = (p.price/100).toFixed(2) + ' ₽';
        document.getElementById('prod-desc').textContent = p.description || 'Нет описания';
        document.getElementById('prod-stock').textContent = p.stock > 0 ? `В наличии: ${p.stock} шт.` : 'Нет в наличии';

        const mainImg = document.getElementById('prod-main-img');
        const thumbs = document.getElementById('prod-thumbs');
        const images = p.images || [];

        if (images.length) {
            mainImg.src = '/uploads/' + images[0];
            thumbs.innerHTML = images.map((img, i) => `
                <img src="/uploads/${img}" class="${i===0?'active':''}" onclick="setMain('${img}',this)" alt="">
            `).join('');
        } else {
            mainImg.style.display = 'none';
        }

        window.setMain = (src, el) => {
            mainImg.src = '/uploads/' + src;
            thumbs.querySelectorAll('img').forEach(img => img.classList.remove('active'));
            el.classList.add('active');
        };

        document.getElementById('add-cart').onclick = () => {
            const cart = JSON.parse(localStorage.getItem('cart') || '[]');
            const existing = cart.find(item => item.id === p.id);
            if (existing) existing.qty++;
            else cart.push({ id: p.id, title: p.title, price: p.price, preview: p.preview_image, qty: 1 });
            localStorage.setItem('cart', JSON.stringify(cart));
            const btn = document.getElementById('add-cart');
            const original = btn.textContent;
            btn.textContent = '✓ Добавлено';
            setTimeout(() => btn.textContent = original, 1500);
        };
    } catch (e) {
        document.body.innerHTML = '<div style="text-align:center;padding:120px 20px"><h2 style="margin-bottom:24px">Товар не найден</h2><a href="shop.html" class="btn btn-primary">В каталог</a></div>';
    }
});
