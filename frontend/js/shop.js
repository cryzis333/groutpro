document.addEventListener('DOMContentLoaded', async () => {
    const grid = document.getElementById('shop-grid');
    try {
        const response = await fetch('/api/products');
        if (!response.ok) throw new Error();
        const products = await response.json();
        grid.replaceChildren();
        if (!products.length) return grid.append(message('Товары скоро появятся'));
        products.forEach(product => grid.append(productCard(product)));
    } catch (_) {
        grid.replaceChildren(message('Ошибка загрузки каталога'));
    }
});

function productCard(product) {
    const card = document.createElement('a');
    card.className = 'shop-card glass';
    card.href = `product.html?id=${encodeURIComponent(product.id)}`;
    const image = document.createElement('div');
    image.className = 'shop-image';
    const imageName = safeImageName(product.preview_image);
    if (imageName) image.style.backgroundImage = `url("/uploads/${encodeURIComponent(imageName)}")`;
    const info = document.createElement('div');
    info.className = 'shop-info';
    const title = document.createElement('h3');
    title.textContent = String(product.title || 'Товар');
    const price = document.createElement('p');
    price.className = 'shop-price';
    price.textContent = `${(Number(product.price) / 100).toFixed(2)} ₽`;
    info.append(title, price);
    card.append(image, info);
    return card;
}

function safeImageName(value) {
    return typeof value === 'string' && /^[a-f0-9-]+\.(?:jpg|png|webp)$/i.test(value) ? value : '';
}

function message(text) {
    const node = document.createElement('p');
    node.style.cssText = 'text-align:center;color:var(--muted);padding:40px 0';
    node.textContent = text;
    return node;
}
