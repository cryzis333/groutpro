document.addEventListener('DOMContentLoaded', async () => {
    const pathId = location.pathname.match(/^\/product\/([a-f0-9-]{36})$/i)?.[1];
    const id = pathId || new URLSearchParams(location.search).get('id');
    if (!/^[a-f0-9-]{36}$/i.test(id || '')) return location.replace('/shop');
    try {
        const response = await fetch(`/api/products/${encodeURIComponent(id)}`);
        if (!response.ok) throw new Error();
        const product = await response.json();
        document.getElementById('prod-title').textContent = product.title;
        document.getElementById('prod-price').textContent = `${(Number(product.price) / 100).toFixed(2)} ₽`;
        document.getElementById('prod-desc').textContent = product.description || 'Нет описания';
        document.getElementById('prod-stock').textContent = product.stock > 0 ? `В наличии: ${product.stock} шт.` : 'Нет в наличии';
        const mainImage = document.getElementById('prod-main-img');
        const thumbnails = document.getElementById('prod-thumbs');
        const images = Array.isArray(product.images) ? product.images.filter(safeImageName) : [];
        thumbnails.replaceChildren();
        if (images.length) {
            setImage(mainImage, images[0]);
            images.forEach((name, index) => {
                const image = document.createElement('img');
                image.alt = `${product.title}, изображение ${index + 1}`;
                image.classList.toggle('active', index === 0);
                setImage(image, name);
                image.addEventListener('click', () => {
                    setImage(mainImage, name);
                    thumbnails.querySelectorAll('img').forEach(node => node.classList.remove('active'));
                    image.classList.add('active');
                });
                thumbnails.append(image);
            });
        } else mainImage.hidden = true;
        const addButton = document.getElementById('add-cart');
        addButton.disabled = product.stock < 1;
        addButton.onclick = () => addToCart(product, addButton);
    } catch (_) {
        const title = document.getElementById('prod-title');
        title.textContent = 'Товар не найден';
        document.getElementById('add-cart').hidden = true;
    }
});

function addToCart(product, button) {
    const cart = readCart();
    const existing = cart.find(item => item.id === product.id);
    if (existing) existing.qty = Math.min(existing.qty + 1, Math.max(1, product.stock));
    else cart.push({ id: product.id, title: product.title, price: product.price, preview: product.preview_image, qty: 1 });
    localStorage.setItem('cart', JSON.stringify(cart));
    const original = button.textContent;
    button.textContent = '✓ Добавлено';
    setTimeout(() => { button.textContent = original; }, 1500);
}

function readCart() {
    try { const value = JSON.parse(localStorage.getItem('cart') || '[]'); return Array.isArray(value) ? value : []; }
    catch (_) { localStorage.removeItem('cart'); return []; }
}
function safeImageName(value) { return typeof value === 'string' && /^[a-f0-9-]+\.(?:jpg|png|webp)$/i.test(value); }
function setImage(node, name) { node.src = `/uploads/${encodeURIComponent(name)}`; }
