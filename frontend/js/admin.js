const API = '/api/admin';
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

    loadViewStats();
}

async function loadViewStats() {
    const listEl = document.getElementById('category-views-list');
    try {
        const res = await api('/api/admin/analytics/views');
        const stats = await res.json();
        document.getElementById('stat-views').textContent = stats.total_views;

        if (!listEl) return;
        if (!stats.categories.length) {
            listEl.innerHTML = '<p style="color:var(--muted);font-size:0.85rem">Пока нет данных по категориям</p>';
            return;
        }
        const max = Math.max(...stats.categories.map(c => c.views));
        listEl.innerHTML = stats.categories.map(c => `
            <div class="category-bar-row">
                <span class="category-bar-label">${escapeHtml(c.category)}</span>
                <span class="category-bar-track"><span class="category-bar-fill" style="width:${(c.views/max*100).toFixed(0)}%"></span></span>
                <span class="category-bar-count">${c.views}</span>
            </div>
        `).join('');
    } catch (e) {
        if (listEl) listEl.innerHTML = '<p style="color:var(--muted);font-size:0.85rem">Не удалось загрузить</p>';
    }
}

async function loadProducts() {
    const res = await fetch('/api/products?page_size=100');
    const products = await res.json();
    productsCache = products;
    const categories = [...new Set(products.map(p => p.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
    document.getElementById('p-cat-list').innerHTML = categories.map(c => `<option value="${escapeHtml(c)}">`).join('');
    const tbody = document.getElementById('products-table');
    if (!products.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:32px">Нет товаров</td></tr>';
        return;
    }
    tbody.innerHTML = products.map(p => `
        <tr>
            <td><img src="/uploads/${p.preview_image || ''}" style="width:48px;height:48px;object-fit:cover;border-radius:8px;background:var(--surface-solid)" onerror="this.style.display='none'"></td>
            <td>${escapeHtml(p.title)}</td>
            <td>${(p.price/100).toFixed(2)} ₽${p.unit ? ' / ' + escapeHtml(p.unit) : ''}</td>
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
        document.getElementById('p-unit').value = product.unit || '';
        document.getElementById('p-stock').value = product.stock;
        document.getElementById('p-discount').value = '';
        const discountsRes = await api('/api/admin/discounts');
        const discounts = await discountsRes.json();
        const activeDiscount = discounts.find(d => d.product_id === product.id && d.is_active);
        if (activeDiscount) document.getElementById('p-discount').value = activeDiscount.percent_bps / 100;
        document.getElementById('product-modal-title').textContent = 'Редактировать товар';
        selectedFiles = [];
        updatePreview();
        showCurrentImages(product.images || []);
        modal.dataset.editId = product.id;
        modal.classList.add('is-open');
    }
    if (deleteButton && confirm('Архивировать товар?')) {
        await api(`/api/admin/products/${deleteButton.dataset.id}`, { method: 'DELETE' });
        loadProducts();
    }
});

async function syncProductDiscount(productId, discountValue) {
    const percent = Number(discountValue);
    const hasNewDiscount = discountValue !== '' && percent > 0;
    const discountsRes = await api('/api/admin/discounts');
    const discounts = await discountsRes.json();
    const existing = discounts.find(d => d.product_id === productId && d.is_active);

    if (existing) {
        const existingPercent = existing.percent_bps / 100;
        if (hasNewDiscount && Math.abs(existingPercent - percent) < 0.001) return;
        await api(`/api/admin/discounts/${existing.id}`, { method: 'DELETE' });
    }
    if (hasNewDiscount) {
        await api('/api/admin/discounts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ product_id: productId, percent, is_registered_only: true })
        });
    }
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
            <td><span class="status-${o.status}">${o.status}</span>${o.payment_method === 'invoice' ? ' <span class="order-invoice">счёт</span>' : ''}</td>
            <td>${new Date(o.created_at).toLocaleString('ru-RU')}</td>
        </tr>
    `).join('');
}

const LEAD_STATUSES = { new: 'Новая', in_progress: 'В обработке', processed: 'Обработана', spam: 'Спам' };
let leadsCache = [];

function statusOptions(current) {
    return Object.entries(LEAD_STATUSES)
        .map(([value, label]) => `<option value="${value}" ${value === current ? 'selected' : ''}>${label}</option>`)
        .join('');
}

function updateLeadsBadge(leads) {
    const badge = document.getElementById('leads-badge');
    const fresh = leads.filter(l => l.status === 'new').length;
    badge.textContent = fresh;
    badge.hidden = fresh === 0;
}

async function loadLeads() {
    const tbody = document.getElementById('leads-table');
    const res = await api('/api/admin/contact-requests');
    leadsCache = await res.json();
    updateLeadsBadge(leadsCache);
    if (!leadsCache.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:32px">Заявок пока нет</td></tr>';
        return;
    }
    tbody.innerHTML = leadsCache.map(l => `
        <tr class="lead-row lead-row--${l.status}">
            <td>${new Date(l.created_at).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</td>
            <td>${escapeHtml(l.name)}${l.source === 'estimate' ? ' <span class="lead-source">замер</span>' : ''}</td>
            <td><a href="tel:${escapeHtml(l.phone.replace(/[^\d+]/g, ''))}" class="inline-link">${escapeHtml(l.phone)}</a></td>
            <td>${l.email ? `<a href="mailto:${escapeHtml(l.email)}" class="inline-link">${escapeHtml(l.email)}</a>` : '—'}</td>
            <td>
                <div class="lead-message">${escapeHtml(l.message)}</div>
                <button class="btn btn-secondary lead-open" data-id="${l.id}" type="button">Открыть</button>
            </td>
            <td>
                <select class="lead-status-select lead-status--${l.status}" data-id="${l.id}" aria-label="Статус заявки">
                    ${statusOptions(l.status)}
                </select>
            </td>
        </tr>
    `).join('');
}

async function setLeadStatus(id, status) {
    const res = await api(`/api/admin/contact-requests/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
    });
    if (!res.ok) alert('Не удалось сохранить статус');
    await loadLeads();
}

const leadModal = document.getElementById('lead-modal');

function openLead(id) {
    const lead = leadsCache.find(l => l.id === id);
    if (!lead) return;
    const estimate = parseEstimate(lead);
    const digits = lead.phone.replace(/\D/g, '');
    const tel = lead.phone.replace(/[^\d+]/g, '');

    document.getElementById('lead-kind').textContent = lead.source === 'estimate' ? 'Заявка на замер по смете' : 'Заявка с сайта';
    document.getElementById('lead-kind').className = `lead-badge lead-badge--${lead.source === 'estimate' ? 'estimate' : 'contact'}`;
    document.getElementById('lead-name').textContent = lead.name;
    document.getElementById('lead-date').textContent = new Date(lead.created_at).toLocaleString('ru-RU', { dateStyle: 'long', timeStyle: 'short' });

    document.getElementById('lead-phone').textContent = lead.phone;
    document.getElementById('lead-phone-link').href = `tel:${tel}`;
    document.getElementById('lead-call').href = `tel:${tel}`;
    document.getElementById('lead-whatsapp').href = `https://wa.me/${digits.replace(/^8/, '7')}`;
    const emailLink = document.getElementById('lead-email-link');
    document.getElementById('lead-email').textContent = lead.email || 'Почты нет';
    emailLink.href = lead.email ? `mailto:${lead.email}` : '#';
    emailLink.classList.toggle('is-empty', !lead.email);

    document.getElementById('lead-copy').onclick = async () => {
        const text = [lead.name, lead.phone, lead.email, lead.message].filter(Boolean).join('\n');
        try {
            await navigator.clipboard.writeText(text);
            document.getElementById('lead-copy').textContent = 'Скопировано';
            setTimeout(() => { document.getElementById('lead-copy').textContent = 'Скопировать'; }, 1500);
        } catch (e) {
            alert('Не удалось скопировать');
        }
    };

    renderStatusBar(lead);
    document.getElementById('lead-message').textContent = lead.message;

    const estimateBlock = document.getElementById('lead-estimate-block');
    if (estimate.length) {
        document.getElementById('lead-estimate').innerHTML = estimate.map(item => `
            <tr>
                <td>${escapeHtml(item.title)}</td>
                <td class="lead-estimate-qty">× ${item.quantity}</td>
                <td class="lead-estimate-sum">${(item.sum / 100).toLocaleString('ru-RU')} ₽</td>
            </tr>`).join('') + `
            <tr class="lead-estimate-total">
                <td>Ориентировочно, без выезда</td>
                <td></td>
                <td class="lead-estimate-sum">${((lead.estimate_total || 0) / 100).toLocaleString('ru-RU')} ₽</td>
            </tr>`;
        estimateBlock.hidden = false;
        const makeOrder = document.getElementById('lead-make-order');
        makeOrder.disabled = false;
        makeOrder.dataset.id = lead.id;
        document.getElementById('lead-order-result').textContent = '';
    } else {
        estimateBlock.hidden = true;
    }
    leadModal.classList.add('is-open');
}

function parseEstimate(lead) {
    try { return JSON.parse(lead.estimate_items || '[]'); } catch (e) { return []; }
}

// Статус — ряд кнопок: видно текущий и меняется в один клик
function renderStatusBar(lead) {
    const bar = document.getElementById('lead-status-bar');
    bar.innerHTML = Object.entries(LEAD_STATUSES).map(([value, label]) => `
        <button type="button" class="lead-status-btn lead-status-btn--${value} ${value === lead.status ? 'is-active' : ''}" data-id="${lead.id}" data-status="${value}">${label}</button>
    `).join('');
}

document.getElementById('leads-table').addEventListener('change', async (event) => {
    const select = event.target.closest('.lead-status-select');
    if (!select) return;
    select.disabled = true;
    await setLeadStatus(select.dataset.id, select.value);
});

document.getElementById('leads-table').addEventListener('click', (event) => {
    const button = event.target.closest('.lead-open');
    if (button) openLead(button.dataset.id);
});

document.getElementById('lead-status-bar').addEventListener('click', async (event) => {
    const button = event.target.closest('.lead-status-btn');
    if (!button || button.classList.contains('is-active')) return;
    button.parentElement.querySelectorAll('.lead-status-btn').forEach(b => b.disabled = true);
    await setLeadStatus(button.dataset.id, button.dataset.status);
    const lead = leadsCache.find(l => l.id === button.dataset.id);
    if (lead) renderStatusBar(lead);
});

document.getElementById('lead-make-order').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const result = document.getElementById('lead-order-result');
    button.disabled = true;
    result.textContent = 'Создаём...';
    try {
        const res = await api(`/api/admin/contact-requests/${button.dataset.id}/order`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Не удалось создать заказ');
        result.textContent = `Заказ ${data.order} создан на ${(data.total / 100).toLocaleString('ru-RU')} ₽`;
        result.style.color = '#22c55e';
        loadLeads();
    } catch (err) {
        result.textContent = err.message;
        result.style.color = 'var(--accent)';
        button.disabled = false;
    }
});

document.getElementById('close-lead-modal').onclick = () => leadModal.classList.remove('is-open');
leadModal.addEventListener('click', (event) => { if (event.target === leadModal) leadModal.classList.remove('is-open'); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') leadModal.classList.remove('is-open'); });

const REVIEW_STATUSES = { new: 'На проверке', published: 'Опубликован', rejected: 'Отклонён' };
const REVIEW_KINDS = { review: 'Отзыв', suggestion: 'Предложение' };
let reviewsCache = [];

function updateReviewsBadge(items) {
    const badge = document.getElementById('reviews-badge');
    const fresh = items.filter(r => r.status === 'new').length;
    badge.textContent = fresh;
    badge.hidden = fresh === 0;
}

async function loadReviews() {
    const tbody = document.getElementById('reviews-table');
    const res = await api('/api/admin/reviews');
    reviewsCache = await res.json();
    updateReviewsBadge(reviewsCache);
    if (!reviewsCache.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:32px">Пока ничего не прислали</td></tr>';
        return;
    }
    tbody.innerHTML = reviewsCache.map(r => `
        <tr class="lead-row lead-row--${r.status === 'published' ? 'processed' : (r.status === 'rejected' ? 'spam' : 'new')}">
            <td>${new Date(r.created_at).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</td>
            <td>${REVIEW_KINDS[r.kind] || r.kind}</td>
            <td>${escapeHtml(r.author_name)}</td>
            <td>${r.rating ? '★'.repeat(r.rating) : '—'}</td>
            <td><div class="lead-message">${escapeHtml(r.message)}</div></td>
            <td>${r.contact ? escapeHtml(r.contact) : '—'}</td>
            <td>
                <select class="lead-status-select review-status-select" data-id="${r.id}" aria-label="Статус">
                    ${Object.entries(REVIEW_STATUSES).map(([value, label]) => `<option value="${value}" ${value === r.status ? 'selected' : ''}>${label}</option>`).join('')}
                </select>
            </td>
        </tr>
    `).join('');
}

document.getElementById('reviews-table').addEventListener('change', async (event) => {
    const select = event.target.closest('.review-status-select');
    if (!select) return;
    select.disabled = true;
    const res = await api(`/api/admin/reviews/${select.dataset.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: select.value })
    });
    if (!res.ok) alert('Не удалось сохранить статус');
    loadReviews();
});

const modal = document.getElementById('product-modal');
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('product-images');
let selectedFiles = [];

document.getElementById('open-modal').onclick = () => {
    modal.classList.add('is-open');
    delete modal.dataset.editId;
    document.getElementById('product-modal-title').textContent = 'Новый товар';
    document.getElementById('product-form').reset();
    selectedFiles = [];
    updatePreview();
    showCurrentImages([]);
};
document.getElementById('close-modal').onclick = () => modal.classList.remove('is-open');

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

function showCurrentImages(images) {
    const note = document.getElementById('current-images-note');
    const box = document.getElementById('current-images');
    if (!images.length) {
        note.hidden = true;
        box.innerHTML = '';
        return;
    }
    note.textContent = 'Текущие фото. Если выбрать новые, они полностью заменят эти.';
    note.hidden = false;
    box.innerHTML = images.map((img, i) => `
        <div class="preview-item ${i === 0 ? 'preview-main' : ''}">
            <img src="/uploads/${encodeURIComponent(img)}" alt="">
            ${i === 0 ? '<span>Превью</span>' : ''}
        </div>
    `).join('');
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

    const discountValue = document.getElementById('p-discount').value;

    const form = new FormData();
    form.append('title', document.getElementById('p-title').value);
    form.append('description', document.getElementById('p-desc').value);
    form.append('price', Math.round(parseFloat(document.getElementById('p-price').value) * 100));
    form.append('category', document.getElementById('p-cat').value);
    form.append('unit', document.getElementById('p-unit').value);
    form.append('stock', document.getElementById('p-stock').value);
    selectedFiles.forEach(f => form.append('images', f));

    try {
        const editId = modal.dataset.editId;
        let productId = editId;
        if (editId) {
            await api(`/api/admin/products/${editId}`, { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ title: document.getElementById('p-title').value, description: document.getElementById('p-desc').value, price: Math.round(parseFloat(document.getElementById('p-price').value) * 100), category: document.getElementById('p-cat').value, unit: document.getElementById('p-unit').value, stock: Number(document.getElementById('p-stock').value) }) });
            if (selectedFiles.length) {
                // Photos go in their own multipart request; they replace the old set.
                const imagesForm = new FormData();
                selectedFiles.forEach(f => imagesForm.append('images', f));
                const imagesRes = await api(`/api/admin/products/${editId}/images`, { method: 'POST', body: imagesForm });
                if (!imagesRes.ok) {
                    const error = await imagesRes.json().catch(() => ({}));
                    throw new Error(error.error || 'Не удалось загрузить фото');
                }
            }
            delete modal.dataset.editId;
        } else {
            const createRes = await api('/api/admin/products', { method: 'POST', body: form });
            const created = await createRes.json();
            productId = created.id;
        }
        await syncProductDiscount(productId, discountValue);
        modal.classList.remove('is-open');
        e.target.reset();
        selectedFiles = [];
        updatePreview();
        loadProducts();
    } catch (err) {
        alert(err.message || 'Ошибка сохранения товара');
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
    const activeId = ['dashboard', 'leads', 'reviews', 'products', 'orders'].includes(requested) ? requested : 'dashboard';
    document.querySelectorAll('.admin-section').forEach(section => {
        section.hidden = section.id !== activeId;
    });
    document.querySelectorAll('.admin-sidebar nav a[href^="#"]').forEach(link => {
        link.classList.toggle('active', link.getAttribute('href') === `#${activeId}`);
    });
    const loaders = { dashboard: loadAnalytics, leads: loadLeads, reviews: loadReviews, products: loadProducts, orders: loadOrders };
    if (loaders[activeId]) loaders[activeId]();
    if (activeId !== 'leads') {
        // Keep the sidebar's "new leads" counter fresh from any section.
        api('/api/admin/contact-requests').then(r => r.ok ? r.json() : []).then(updateLeadsBadge).catch(() => {});
        api('/api/admin/reviews').then(r => r.ok ? r.json() : []).then(updateReviewsBadge).catch(() => {});
    }
    modal.classList.remove('is-open');
}

if (location.pathname === '/admin' || location.pathname.includes('admin.html')) {
    checkAuth();
    window.addEventListener('hashchange', switchAdminSection);
    switchAdminSection();
}
