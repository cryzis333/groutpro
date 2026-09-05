const API = '/api/admin';

async function api(url, opts={}) {
    const res = await fetch(url, {
        ...opts,
        headers: { ...(opts.headers || {}) }
    });
    if (res.status === 401) {
        location.href = 'admin-login.html';
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
            <td><button class="btn btn-secondary" style="padding:8px 16px;font-size:0.75rem" onclick="deleteProduct('${p.id}')">Удалить</button></td>
        </tr>
    `).join('');
}

window.deleteProduct = async (id) => {
    if (!confirm('Удалить товар?')) return;
    await api(`/api/admin/products/${id}`, { method: 'DELETE' });
    loadProducts();
};

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
        await api('/api/admin/products', { method: 'POST', body: form });
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

if (location.pathname.includes('admin.html')) {
    loadAnalytics();
    loadProducts();
    loadOrders();
}
