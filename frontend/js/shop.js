let products = [];
const grid = document.getElementById('shop-grid');
const categoryFilter = document.getElementById('category-filter');
const sortProducts = document.getElementById('sort-products');

document.addEventListener('DOMContentLoaded', loadProducts);
categoryFilter?.addEventListener('change', renderProducts);
sortProducts?.addEventListener('change', renderProducts);

async function loadProducts() {
    try {
        const response = await fetch('/api/products');
        if (!response.ok) throw new Error('Не удалось загрузить каталог');
        products = await response.json();
        fillCategories();
        renderProducts();
    } catch (error) {
        grid.replaceChildren(message(error.message));
    }
}

function fillCategories() {
    if (!categoryFilter) return;
    [...new Set(products.map(product => product.category).filter(Boolean))].sort().forEach(category => {
        const option = document.createElement('option'); option.value = category; option.textContent = category; categoryFilter.append(option);
    });
}
function renderProducts() {
    const category = categoryFilter?.value || '';
    let visible = products.filter(product => !category || product.category === category);
    if (sortProducts?.value === 'price-asc') visible.sort((a,b) => a.price - b.price);
    if (sortProducts?.value === 'price-desc') visible.sort((a,b) => b.price - a.price);
    grid.replaceChildren();
    if (!visible.length) return grid.append(message('В этой категории пока нет товаров'));
    visible.forEach(product => grid.append(productCard(product)));
}
function productCard(product) {
    const card = document.createElement('a'); card.className='shop-card glass'; card.href=`/product/${encodeURIComponent(product.id)}`;
    const imageWrap=document.createElement('div'); imageWrap.className='shop-image';
    if (safeImageName(product.preview_image)) { const image=document.createElement('img'); image.src=`/uploads/${encodeURIComponent(product.preview_image)}`; image.alt=product.title; image.loading='lazy'; imageWrap.append(image); }
    const info=document.createElement('div'); info.className='shop-info'; const title=document.createElement('h3'); title.textContent=String(product.title||'Товар'); const price=document.createElement('p'); price.className='shop-price'; price.textContent=`${(Number(product.price)/100).toFixed(2)} ₽`;
    const stock=document.createElement('p'); stock.style.color='var(--muted)'; stock.textContent=product.stock>0?`В наличии: ${product.stock}`:'Нет в наличии'; info.append(title,price,stock); card.append(imageWrap,info); return card;
}
function safeImageName(value) { return typeof value==='string' && /^[a-f0-9-]+\.(?:jpg|png|webp)$/i.test(value) ? value : ''; }
function message(text) { const node=document.createElement('p'); node.style.cssText='text-align:center;color:var(--muted);padding:40px 0'; node.textContent=text; return node; }
