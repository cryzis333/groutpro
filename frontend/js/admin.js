let token = localStorage.getItem('admin_token');

function checkAuth() {
    if (!token) location.href = '/admin/login';
}


async function api(url, opts={}) {
    const res = await fetch(url, {
        ...opts,
        headers: {
            ...(opts.headers || {}),
            'Authorization': 'Bearer ' + token
        }
    });
    if (res.status === 401) {
        localStorage.removeItem('admin_token');
        location.href = '/admin/login';
    }
    return res;
}

async function loadAnalytics() {
    const res = await api('/api/admin/analytics');
    const data = await res.json();
    const labels = data.map(d => new Date(d.date).toLocaleDateString('ru-RU')).reverse();
    const revenues = data.map(d => (d.revenue || 0)/100).reverse();
    const counts = data.map(d => parseInt(d.orders_count || 0)).reverse();

    const totalRev = revenues.reduce((a,b)=>a+b,0);
    const totalOrd = counts.reduce((a,b)=>a+b,0);

    document.getElementById('stat-revenue').textContent = totalRev.toFixed(2) + ' ₽';
    document.getElementById('stat-orders').textContent = totalOrd;
    document.getElementById('stat-avg').textContent = (totalRev / (totalOrd || 1)).toFixed(2) + ' ₽';

    new Chart(document.getElementById('revenueChart'), {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: 'Выручка, ₽',
                data: revenues,
                borderColor: '#FF3D00',
                backgroundColor: 'rgba(255,61,0,0.08)',
                fill: true,
                tension: 0.4,
                pointRadius: 3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: { grid: { color: 'rgba(128,128,128,0.1)' }, ticks: { color: 'var(--muted)' } },
                x: { grid: { display: false }, ticks: { color: 'var(--muted)' } }
            }
        }
    });
}

async function loadProducts() {
    const res = await fetch('/api/products');
    const products = await res.json();
    productsCache = products;
    const tbody = document.getElementById('products-table');
    if (!products.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:32px">Нет товаров</td></tr>';
        return;
    }
    tbody.innerHTML = products.map(p => `
        <tr>
            <td><img src="/uploads/${p.preview_image || ''}" style="width:48px;height:48px;object-fit:cover;border-radius:8px;background:var(--surface-solid)" onerror="this.style.display='none'"></td>
            <td>${escapeHtml(p.title)}</td>
            <td>${(p.price/100).toFixed(2)} ₽</td>
            <td>${p.stock}</td>
            <td><button class="btn btn-secondary product-edit" data-id="${p.id}" style="padding:8px 16px;font-size:0.75rem">Изменить</button> <button class="btn btn-secondary product-delete" data-id="${p.id}" style="padding:8px 16px;font-size:0.75rem">Архивировать</button></td>
        </tr>
    `).join('');
}

let productsCache = [];

document.getElementById('products-table').addEventListener('click', async (event) => {
    const editButton = event.target.closest('.product-edit');
    const deleteButton = event.target.closest('.product-delete');
    if (editButton) {
        const product = productsCache.find(item => item.id === editButton.dataset.id);
        if (!product) return;
        document.getElementById('p-title').value = product.title;
        document.getElementById('p-desc').value = product.description || '';
        document.getElementById('p-price').value = (product.price / 100).toFixed(2);
        document.getElementById('p-cat').value = product.category || '';
        document.getElementById('p-stock').value = product.stock;
        document.getElementById('product-modal-title').textContent = 'Редактировать товар';
        modal.dataset.editId = product.id;
        modal.style.display = 'flex';
    }
    if (deleteButton && confirm('Архивировать товар?')) {
        await api(`/api/admin/products/${deleteButton.dataset.id}`, { method: 'DELETE' });
        loadProducts();
    }
});

async function loadDiscounts() {
    const res = await api('/api/admin/discounts');
    const discounts = await res.json();
    const tbody = document.getElementById('discounts-table');
    tbody.innerHTML = discounts.length ? discounts.map(d => `
        <tr><td>${escapeHtml(d.category || d.product_id || 'Товар')}</td><td>${(d.percent_bps / 100).toFixed(2)}%</td><td>${d.is_registered_only ? 'Да' : 'Нет'}</td><td>${d.is_active ? 'Активна' : 'Отключена'}</td><td>${d.is_active ? `<button class="btn btn-secondary discount-delete" data-id="${d.id}" style="padding:8px 16px;font-size:.75rem">Отключить</button>` : ''}</td></tr>
    `).join('') : '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:32px">Скидок нет</td></tr>';
}

async function loadOrders() {
    const res = await api('/api/admin/orders');
    const orders = await res.json();
    const tbody = document.getElementById('orders-table');
    if (!orders.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:32px">Нет заказов</td></tr>';
        return;
    }
    tbody.innerHTML = orders.map(o => `
        <tr>
            <td>#${o.id.slice(0,8)}</td>
            <td>${escapeHtml(o.customer_name)}</td>
            <td>${(o.total_amount/100).toFixed(2)} ₽</td>
            <td><span class="status-${o.status}">${o.status}</span></td>
            <td>${new Date(o.created_at).toLocaleString('ru-RU')}</td>
        </tr>
    `).join('');
}

const modal = document.getElementById('product-modal');
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('product-images');
let selectedFiles = [];

document.getElementById('open-modal').onclick = () => {
    modal.style.display = 'flex';
    delete modal.dataset.editId;
    document.getElementById('product-modal-title').textContent = 'Новый товар';
    document.getElementById('product-form').reset();
    selectedFiles = [];
    updatePreview();
};
document.getElementById('close-modal').onclick = () => modal.style.display = 'none';

dropZone.onclick = () => fileInput.click();
dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add('dragover'); };
dropZone.ondragleave = () => dropZone.classList.remove('dragover');
dropZone.ondrop = (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    addFiles(e.dataTransfer.files);
};
fileInput.onchange = (e) => addFiles(e.target.files);

function addFiles(files) {
    if (selectedFiles.length + files.length > 10) {
        alert('Максимум 10 фотографий');
        return;
    }
    selectedFiles = [...selectedFiles, ...Array.from(files).slice(0, 10-selectedFiles.length)];
    updatePreview();
}

function updatePreview() {
    const preview = document.getElementById('image-preview');
    preview.innerHTML = selectedFiles.map((f, i) => `
        <div class="preview-item ${i===0?'preview-main':''}">
            <img src="${URL.createObjectURL(f)}">
            ${i===0?'<span>Превью</span>':''}
        </div>
    `).join('');
}

document.getElementById('product-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const original = btn.textContent;
    btn.textContent = 'Создание...';
    btn.disabled = true;

    const form = new FormData();
    form.append('title', document.getElementById('p-title').value);
    form.append('description', document.getElementById('p-desc').value);
    form.append('price', Math.round(parseFloat(document.getElementById('p-price').value) * 100));
    form.append('category', document.getElementById('p-cat').value);
    form.append('stock', document.getElementById('p-stock').value);
    selectedFiles.forEach(f => form.append('images', f));

    try {
        const editId = modal.dataset.editId;
        if (editId) {
            await api(`/api/admin/products/${editId}`, { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ title: document.getElementById('p-title').value, description: document.getElementById('p-desc').value, price: Math.round(parseFloat(document.getElementById('p-price').value) * 100), category: document.getElementById('p-cat').value, stock: Number(document.getElementById('p-stock').value) }) });
            delete modal.dataset.editId;
        } else {
            await api('/api/admin/products', { method: 'POST', body: form });
        }
        modal.style.display = 'none';
        e.target.reset();
        selectedFiles = [];
        updatePreview();
        loadProducts();
    } catch (err) {
        alert('Ошибка создания товара');
    } finally {
        btn.textContent = original;
        btn.disabled = false;
    }
};

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function switchAdminSection() {
    const requested = location.hash.slice(1);
    const activeId = ['dashboard', 'products', 'orders', 'discounts'].includes(requested) ? requested : 'dashboard';
    document.querySelectorAll('.admin-section').forEach(section => {
        section.hidden = section.id !== activeId;
    });
    document.querySelectorAll('.admin-sidebar nav a[href^="#"]').forEach(link => {
        link.classList.toggle('active', link.getAttribute('href') === `#${activeId}`);
    });
    const loaders = { dashboard: loadAnalytics, products: loadProducts, orders: loadOrders, discounts: loadDiscounts };
    if (loaders[activeId]) loaders[activeId]();
}

if (location.pathname === '/admin' || location.pathname.includes('admin.html')) {
    checkAuth();
    window.addEventListener('hashchange', switchAdminSection);
    switchAdminSection();
}

const discountModal = document.getElementById('discount-modal');
if (discountModal) {
document.getElementById('open-discount-modal').onclick = () => discountModal.style.display = 'flex';
document.getElementById('close-discount-modal').onclick = () => discountModal.style.display = 'none';
document.getElementById('discount-form').onsubmit = async (event) => {
    event.preventDefault();
    const category = document.getElementById('d-category').value.trim();
    const percent = Number(document.getElementById('d-percent').value);
    if (!category) return alert('Укажите категорию');
    await api('/api/admin/discounts', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ category, percent, is_registered_only: document.getElementById('d-registered').checked }) });
    discountModal.style.display = 'none';
    event.target.reset();
    loadDiscounts();
};
document.getElementById('discounts-table').addEventListener('click', async (event) => {
    const button = event.target.closest('.discount-delete');
    if (!button || !confirm('Отключить скидку?')) return;
    await api(`/api/admin/discounts/${button.dataset.id}`, { method: 'DELETE' });
    loadDiscounts();
});
}
