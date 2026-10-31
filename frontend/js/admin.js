'use strict';
// Админ-панель ГраутПро: аналитика, заявки, отзывы, товары, скидки и заказы.
// Работает и со старым, и с обновлённым бэкендом: новые поля (sort_order,
// payment_method, company_*, daily/pages в аналитике, GET /api/admin/products)
// используются, когда они есть, а без них страница показывает то, что пришло.

const ADMIN_API = '/api/admin';
const token = readToken();

function readToken() {
    try { return localStorage.getItem('admin_token'); } catch (e) { return null; }
}

function goToLogin(expired) {
    try { localStorage.removeItem('admin_token'); } catch (e) { /* хранилище недоступно — просто уходим */ }
    location.replace(expired ? '/admin/login?expired=1' : '/admin/login');
}

const $ = id => document.getElementById(id);
const DASH = '<span class="muted">—</span>';

// ------------------------------------------------------------------ форматирование

const moneyWhole = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 });
const moneyExact = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const intFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const percentFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const compactFormat = new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 });
const dateTimeFormat = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
const dateFormat = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
const longDateTimeFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeStyle: 'short' });

// Копейки → «18 900 ₽» (копейки показываем, только если они есть)
function money(kopecks) {
    const value = Number(kopecks) || 0;
    return (value % 100 === 0 ? moneyWhole : moneyExact).format(value / 100);
}

// Для карточек дашборда — до рубля: «1 432 017 ₽»
function moneyRounded(kopecks) {
    return moneyWhole.format(Math.round((Number(kopecks) || 0) / 100));
}

function formatInt(value) {
    return intFormat.format(Number(value) || 0);
}

function formatPercentBps(bps) {
    return percentFormat.format((Number(bps) || 0) / 100) + ' %';
}

function formatDate(value, format = dateTimeFormat) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : format.format(date);
}

// Дата для таблицы: «19.10.26, 10:06», в узкой колонке время уходит на вторую строку
function dateCell(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return DASH;
    const [day, time] = dateTimeFormat.format(date).split(', ');
    const timePart = time ? ` <span class="nowrap">${escapeHtml(time)}</span>` : '';
    return `<time datetime="${date.toISOString()}"><span class="nowrap">${escapeHtml(day)}${time ? ',' : ''}</span>${timePart}</time>`;
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

function cssToken(value) {
    return String(value ?? '').replace(/[^a-z0-9_-]/gi, '');
}

function telHref(phone) {
    return 'tel:' + String(phone || '').replace(/[^\d+]/g, '');
}

function toArray(value) {
    return Array.isArray(value) ? value : [];
}

// ------------------------------------------------------------------ запросы

async function request(url, opts = {}) {
    try {
        return await fetch(url, opts);
    } catch (e) {
        throw new Error('Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.');
    }
}

async function api(url, opts = {}) {
    const res = await request(url, {
        ...opts,
        headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token }
    });
    if (res.status === 401) {
        goToLogin(true);
        throw new Error('Сессия истекла — войдите снова.');
    }
    return res;
}

async function readJson(res) {
    try { return await res.json(); } catch (e) { return null; }
}

function errorMessage(res, data, fallback) {
    const text = data && typeof data.error === 'string' ? data.error : '';
    if (/[а-яё]/i.test(text)) return text;
    if (res.status === 413) return 'Файлы слишком большие для сервера. Уменьшите размер или количество фото.';
    if (res.status === 404) return 'Не найдено — возможно, запись уже удалена. Обновите страницу.';
    if (res.status >= 500) return `Ошибка сервера (код ${res.status}). Попробуйте позже.`;
    return fallback || `Запрос не выполнен (код ${res.status}).`;
}

async function apiJson(url, opts, fallback) {
    const res = await api(url, opts);
    const data = await readJson(res);
    if (!res.ok) throw new Error(errorMessage(res, data, fallback));
    return data;
}

function jsonBody(method, body) {
    return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function emptyRow(colspan, text, isError) {
    return `<tr><td class="admin-empty${isError ? ' is-error' : ''}" colspan="${colspan}">${escapeHtml(text)}</td></tr>`;
}

// ------------------------------------------------------------------ уведомления

let toastTimer;
function toast(message, isError) {
    let el = $('admin-toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'admin-toast';
        el.className = 'admin-toast';
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.toggle('is-error', Boolean(isError));
    el.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-visible'), isError ? 6000 : 3500);
}

// ------------------------------------------------------------------ окна

const layout = $('admin-layout');
const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
const modalState = { current: null, returnFocus: null };
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function openModal(overlay, focusTarget) {
    if (modalState.current && modalState.current !== overlay) closeModal({ restoreFocus: false });
    if (!modalState.current) modalState.returnFocus = document.activeElement;
    modalState.current = overlay;
    overlay.classList.add('is-open');
    document.body.classList.add('modal-open');
    if (layout) layout.inert = true;
    const dialog = overlay.querySelector('[role="dialog"]');
    const body = overlay.querySelector('.modal-body');
    if (body) body.scrollTop = 0;
    // На телефоне не открываем клавиатуру сами — фокус на окне, а не на поле
    const target = finePointer.matches && focusTarget ? focusTarget : dialog;
    if (target) target.focus({ preventScroll: true });
}

function closeModal({ restoreFocus = true, force = false } = {}) {
    const overlay = modalState.current;
    if (!overlay) return;
    // Keep the product form open while it is saving, so a late error is not lost
    if (overlay === productModal && savingProduct && !force) return;
    modalState.current = null;
    overlay.classList.remove('is-open');
    document.body.classList.remove('modal-open');
    if (layout) layout.inert = false;
    if (overlay === productModal) resetSelectedImages();
    const back = modalState.returnFocus;
    modalState.returnFocus = null;
    if (restoreFocus && back && document.contains(back) && typeof back.focus === 'function') {
        back.focus({ preventScroll: true });
    }
}

document.querySelectorAll('.modal-overlay').forEach(overlay => {
    let pressedOnOverlay = false;
    overlay.addEventListener('pointerdown', event => { pressedOnOverlay = event.target === overlay; });
    overlay.addEventListener('click', event => {
        if (event.target === overlay && pressedOnOverlay) closeModal();
        pressedOnOverlay = false;
    });
    overlay.querySelectorAll('[data-close-modal]').forEach(button => button.addEventListener('click', () => closeModal()));
    overlay.addEventListener('keydown', event => {
        if (event.key !== 'Tab') return;
        const dialog = overlay.querySelector('[role="dialog"]');
        const items = [...dialog.querySelectorAll(FOCUSABLE)].filter(el => el.getClientRects().length > 0);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    });
});

document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && modalState.current) {
        event.preventDefault();
        closeModal();
    }
});

// ------------------------------------------------------------------ аналитика

const charts = {};
let chartLibraryPromise = null;
let dashboardSeq = 0;

// Chart.js подключён с defer и может не загрузиться (CDN недоступен) —
// тогда дашборд показывает цифры без графиков.
function loadChartLibrary() {
    if (window.Chart) return Promise.resolve(window.Chart);
    if (!chartLibraryPromise) {
        chartLibraryPromise = new Promise((resolve, reject) => {
            const script = $('chartjs');
            let timer;
            const settle = () => {
                clearTimeout(timer);
                if (window.Chart) resolve(window.Chart);
                else reject(new Error('Chart.js не загрузился'));
            };
            if (!script || document.readyState === 'complete') { settle(); return; }
            script.addEventListener('load', settle, { once: true });
            script.addEventListener('error', settle, { once: true });
            window.addEventListener('load', settle, { once: true });
            timer = setTimeout(settle, 10000);
        });
        chartLibraryPromise.catch(() => { chartLibraryPromise = null; });
    }
    return chartLibraryPromise;
}

function destroyChart(key, canvas) {
    if (charts[key]) {
        charts[key].destroy();
        delete charts[key];
    }
    const Chart = window.Chart;
    const existing = Chart && typeof Chart.getChart === 'function' ? Chart.getChart(canvas) : null;
    if (existing) existing.destroy();
}

function cssVar(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
}

function withAlpha(color, alpha) {
    const hex = color.replace('#', '');
    if (!/^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) return color;
    const full = hex.length === 3 ? hex.split('').map(ch => ch + ch).join('') : hex;
    const [r, g, b] = [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function chartTheme() {
    return {
        accent: cssVar('--accent', '#FF3D00'),
        text: cssVar('--text-secondary', '#AAAAAA'),
        grid: cssVar('--border-glass', 'rgba(255, 255, 255, 0.08)'),
        font: cssVar('--font', 'Inter, sans-serif')
    };
}

function chartOptions(theme, formatValue, integerTicks) {
    const font = { family: theme.font, size: 12 };
    return {
        responsive: true,
        maintainAspectRatio: false,
        animation: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? false : { duration: 400 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: ctx => formatValue(ctx.parsed.y) } }
        },
        scales: {
            x: {
                grid: { display: false },
                border: { color: theme.grid },
                ticks: { color: theme.text, font, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 }
            },
            y: {
                beginAtZero: true,
                grid: { color: theme.grid },
                border: { display: false },
                ticks: {
                    color: theme.text,
                    font,
                    maxTicksLimit: 5,
                    precision: integerTicks ? 0 : undefined,
                    callback: value => compactFormat.format(value)
                }
            }
        }
    };
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

function dayKey(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

// Последние 30 дней по местному времени, от старых к новым
function lastDays(count) {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    return Array.from({ length: count }, (_, i) => {
        const day = new Date(today);
        day.setDate(today.getDate() - (count - 1 - i));
        return { key: dayKey(day), label: `${pad2(day.getDate())}.${pad2(day.getMonth() + 1)}` };
    });
}

function renderBars(container, rows, emptyText) {
    if (!rows.length) {
        container.innerHTML = `<p class="admin-note">${escapeHtml(emptyText)}</p>`;
        return;
    }
    const max = Math.max(1, ...rows.map(row => row.value));
    container.innerHTML = rows.map(row => `
        <div class="category-bar-row">
            <span class="category-bar-label">${escapeHtml(row.label)}${row.sub ? `<small>${escapeHtml(row.sub)}</small>` : ''}</span>
            <span class="category-bar-track" aria-hidden="true"><span class="category-bar-fill" style="width:${Math.max(2, Math.round(row.value / max * 100))}%"></span></span>
            <span class="category-bar-count">${formatInt(row.value)}</span>
        </div>
    `).join('');
}

const PAGE_NAMES = {
    '/': 'Главная',
    '/index.html': 'Главная',
    '/shop': 'Магазин',
    '/shop.html': 'Магазин',
    '/cart': 'Корзина',
    '/cart.html': 'Корзина',
    '/account': 'Личный кабинет',
    '/account.html': 'Личный кабинет',
    '/privacy-policy': 'Политика конфиденциальности',
    '/privacy-policy.html': 'Политика конфиденциальности',
    '/product': 'Карточки товаров',
    '/product.html': 'Карточки товаров'
};

function productIdFromPath(path) {
    const [pathname, query = ''] = String(path || '').split('#')[0].split('?');
    const clean = match => (match ? match[1] : null);
    return clean(pathname.match(/^\/product\/([0-9a-f-]{36})\/?$/i))
        || (/^\/product(\.html)?$/.test(pathname) ? new URLSearchParams(query).get('id') : null);
}

function describePage(path, products) {
    const productId = productIdFromPath(path);
    if (productId) {
        const product = products.find(item => item.id === productId);
        return { label: product ? product.title : 'Карточка товара', sub: path };
    }
    const pathname = String(path || '').split(/[?#]/)[0].replace(/(.)\/+$/, '$1') || '/';
    const name = PAGE_NAMES[pathname];
    return name ? { label: name, sub: path === '/' ? '' : path } : { label: path || '—', sub: '' };
}

async function loadDashboard() {
    const seq = ++dashboardSeq;
    const [revenueResult, viewsResult] = await Promise.allSettled([
        apiJson(`${ADMIN_API}/analytics`, undefined, 'Не удалось загрузить выручку'),
        apiJson(`${ADMIN_API}/analytics/views`, undefined, 'Не удалось загрузить посещения')
    ]);
    if (seq !== dashboardSeq) return;

    const days = lastDays(30);
    const problems = [];
    let revenueSeries = null;
    let viewsSeries = null;

    // Выручка: бэкенд отдаёт только дни с оплаченными заказами — дополняем нулями
    if (revenueResult.status === 'fulfilled') {
        const byDay = new Map();
        for (const row of toArray(revenueResult.value)) {
            const date = new Date(row.date);
            if (Number.isNaN(date.getTime())) continue;
            const key = dayKey(date);
            const prev = byDay.get(key) || { revenue: 0, orders: 0 };
            byDay.set(key, { revenue: prev.revenue + (Number(row.revenue) || 0), orders: prev.orders + (Number(row.orders_count) || 0) });
        }
        const revenues = days.map(day => (byDay.get(day.key) || {}).revenue || 0);
        const totalRevenue = revenues.reduce((a, b) => a + b, 0);
        const totalOrders = days.reduce((sum, day) => sum + ((byDay.get(day.key) || {}).orders || 0), 0);
        $('stat-revenue').textContent = moneyRounded(totalRevenue);
        $('stat-orders').textContent = formatInt(totalOrders);
        $('stat-avg').textContent = totalOrders ? moneyRounded(totalRevenue / totalOrders) : '—';
        revenueSeries = { labels: days.map(day => day.label), data: revenues.map(v => v / 100), total: totalRevenue };
    } else {
        ['stat-revenue', 'stat-orders', 'stat-avg'].forEach(id => { $(id).textContent = '—'; });
        problems.push(revenueResult.reason.message);
    }

    const categoryList = $('category-views-list');
    const pagesPanel = $('top-pages-panel');
    const dailyPanel = $('daily-views-panel');
    if (viewsResult.status === 'fulfilled' && viewsResult.value) {
        const stats = viewsResult.value;
        $('stat-views').textContent = formatInt(stats.total_views);
        renderBars(categoryList,
            toArray(stats.categories).map(c => ({ label: c.category, value: Number(c.views) || 0 })),
            'Пока нет данных по категориям');

        const pages = toArray(stats.pages);
        pagesPanel.hidden = !Array.isArray(stats.pages);
        if (Array.isArray(stats.pages)) {
            const needTitles = pages.some(page => productIdFromPath(page.path));
            const products = needTitles ? await getProductsList().catch(() => []) : [];
            if (seq !== dashboardSeq) return;
            renderBars($('top-pages-list'),
                pages.map(page => ({ ...describePage(page.path, products), value: Number(page.views) || 0 })),
                'Пока нет данных по страницам');
        }

        dailyPanel.hidden = !Array.isArray(stats.daily);
        if (Array.isArray(stats.daily)) {
            const byDay = new Map(stats.daily.map(row => [String(row.date).slice(0, 10), Number(row.views) || 0]));
            viewsSeries = { labels: days.map(day => day.label), data: days.map(day => byDay.get(day.key) || 0) };
            viewsSeries.total = viewsSeries.data.reduce((a, b) => a + b, 0);
        }
    } else {
        $('stat-views').textContent = '—';
        categoryList.innerHTML = '<p class="admin-note">Не удалось загрузить</p>';
        pagesPanel.hidden = true;
        dailyPanel.hidden = true;
        if (viewsResult.status === 'rejected') problems.push(viewsResult.reason.message);
    }

    const errorBox = $('analytics-error');
    errorBox.textContent = problems.join(' ');
    errorBox.hidden = problems.length === 0;

    await renderDashboardCharts(seq, revenueSeries, viewsSeries);
}

function setChartState(boxId, noteId, note) {
    $(boxId).hidden = Boolean(note);
    const noteEl = $(noteId);
    noteEl.textContent = note || '';
    noteEl.hidden = !note;
}

async function renderDashboardCharts(seq, revenueSeries, viewsSeries) {
    const revenueCanvas = $('revenueChart');
    const viewsCanvas = $('viewsChart');
    let Chart;
    try {
        Chart = await loadChartLibrary();
    } catch (e) {
        if (seq !== dashboardSeq) return;
        const note = 'График не загрузился (нет доступа к cdn.jsdelivr.net). Цифры выше — актуальные.';
        setChartState('revenue-chart-box', 'revenue-chart-note', revenueSeries ? note : 'Нет данных о выручке.');
        if (viewsSeries) setChartState('views-chart-box', 'views-chart-note', note);
        return;
    }
    if (seq !== dashboardSeq) return;
    const theme = chartTheme();

    destroyChart('revenue', revenueCanvas);
    if (!revenueSeries) {
        setChartState('revenue-chart-box', 'revenue-chart-note', 'Нет данных о выручке.');
    } else if (!revenueSeries.total) {
        setChartState('revenue-chart-box', 'revenue-chart-note', 'За последние 30 дней оплаченных заказов нет.');
    } else {
        setChartState('revenue-chart-box', 'revenue-chart-note', '');
        charts.revenue = new Chart(revenueCanvas, {
            type: 'line',
            data: {
                labels: revenueSeries.labels,
                datasets: [{
                    label: 'Выручка, ₽',
                    data: revenueSeries.data,
                    borderColor: theme.accent,
                    backgroundColor: withAlpha(theme.accent, 0.12),
                    borderWidth: 2,
                    fill: true,
                    tension: 0.35,
                    pointRadius: 2,
                    pointHoverRadius: 5
                }]
            },
            options: chartOptions(theme, value => money(Math.round(value * 100)), false)
        });
    }

    destroyChart('views', viewsCanvas);
    if (viewsSeries) {
        if (!viewsSeries.total) {
            setChartState('views-chart-box', 'views-chart-note', 'За последние 30 дней посещений нет.');
        } else {
            setChartState('views-chart-box', 'views-chart-note', '');
            charts.views = new Chart(viewsCanvas, {
                type: 'bar',
                data: {
                    labels: viewsSeries.labels,
                    datasets: [{
                        label: 'Посещения',
                        data: viewsSeries.data,
                        backgroundColor: withAlpha(theme.accent, 0.6),
                        hoverBackgroundColor: theme.accent,
                        borderRadius: 3,
                        maxBarThickness: 18
                    }]
                },
                options: chartOptions(theme, value => `${formatInt(value)} посещ.`, true)
            });
        }
    }
}

// ------------------------------------------------------------------ заявки

const LEAD_STATUSES = { new: 'Новая', in_progress: 'В обработке', processed: 'Обработана', spam: 'Спам' };
let leadsCache = [];

function statusOptions(statuses, current) {
    const entries = Object.entries(statuses);
    if (current && !statuses[current]) entries.push([current, current]);
    return entries
        .map(([value, label]) => `<option value="${escapeHtml(value)}"${value === current ? ' selected' : ''}>${escapeHtml(label)}</option>`)
        .join('');
}

function updateBadge(id, items) {
    const badge = $(id);
    const fresh = toArray(items).filter(item => item.status === 'new').length;
    badge.textContent = fresh;
    badge.hidden = fresh === 0;
    badge.setAttribute('aria-label', `новых: ${fresh}`);
}

function leadRow(lead) {
    const status = cssToken(lead.status);
    const isEstimate = lead.source === 'estimate';
    return `
        <tr class="lead-row lead-row--${status}" data-id="${escapeHtml(lead.id)}">
            <td data-label="Дата" class="cell-date">${dateCell(lead.created_at)}</td>
            <td data-label="Имя" class="cell-name"><span class="cell-strong">${escapeHtml(lead.name)}</span>${isEstimate ? ' <span class="lead-source">замер</span>' : ''}</td>
            <td data-label="Телефон" class="nowrap">${lead.phone ? `<a href="${escapeHtml(telHref(lead.phone))}" class="inline-link tap-link">${escapeHtml(lead.phone)}</a>` : DASH}</td>
            <td data-label="Email" class="cell-email">${lead.email ? `<a href="mailto:${escapeHtml(lead.email)}" class="inline-link tap-link">${escapeHtml(lead.email)}</a>` : DASH}</td>
            <td data-label="Задача">
                <div class="lead-message">${escapeHtml(lead.message)}</div>
                <button class="btn btn-secondary btn-sm lead-open" data-id="${escapeHtml(lead.id)}" type="button">Открыть</button>
            </td>
            <td data-label="Статус">
                <select class="lead-status-select lead-status--${status}" data-id="${escapeHtml(lead.id)}" aria-label="Статус заявки: ${escapeHtml(lead.name)}">
                    ${statusOptions(LEAD_STATUSES, lead.status)}
                </select>
            </td>
        </tr>`;
}

async function loadLeads() {
    const tbody = $('leads-table');
    try {
        leadsCache = toArray(await apiJson(`${ADMIN_API}/contact-requests`, undefined, 'Не удалось загрузить заявки'));
    } catch (err) {
        tbody.innerHTML = emptyRow(6, err.message, true);
        return;
    }
    updateBadge('leads-badge', leadsCache);
    tbody.innerHTML = leadsCache.length ? leadsCache.map(leadRow).join('') : emptyRow(6, 'Заявок пока нет');
}

function refreshLeadRow(lead) {
    const row = $('leads-table').querySelector(`tr[data-id="${CSS.escape(lead.id)}"]`);
    if (row) row.outerHTML = leadRow(lead);
    updateBadge('leads-badge', leadsCache);
}

async function setLeadStatus(id, status) {
    const lead = leadsCache.find(item => item.id === id);
    try {
        await apiJson(`${ADMIN_API}/contact-requests/${encodeURIComponent(id)}`, jsonBody('PATCH', { status }), 'Не удалось сохранить статус');
        if (lead) lead.status = status;
        return true;
    } catch (err) {
        toast(err.message, true);
        return false;
    } finally {
        if (lead) refreshLeadRow(lead);
    }
}

$('leads-table').addEventListener('change', async event => {
    const select = event.target.closest('.lead-status-select');
    if (!select) return;
    select.disabled = true;
    const id = select.dataset.id;
    await setLeadStatus(id, select.value);
    const fresh = $('leads-table').querySelector(`.lead-status-select[data-id="${CSS.escape(id)}"]`);
    if (fresh) fresh.focus({ preventScroll: true });
});

$('leads-table').addEventListener('click', event => {
    const button = event.target.closest('.lead-open');
    if (button) openLead(button.dataset.id);
});

const leadModal = $('lead-modal');

function parseEstimate(lead) {
    if (Array.isArray(lead.estimate_items)) return lead.estimate_items;
    try {
        return toArray(JSON.parse(lead.estimate_items || '[]'));
    } catch (e) {
        return [];
    }
}

function whatsappNumber(phone) {
    let digits = String(phone || '').replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('8')) digits = '7' + digits.slice(1);
    if (digits.length === 10) digits = '7' + digits;
    return digits.length >= 11 ? digits : '';
}

function openLead(id) {
    const lead = leadsCache.find(item => item.id === id);
    if (!lead) return;
    const estimate = parseEstimate(lead);
    const isEstimate = lead.source === 'estimate';

    const kind = $('lead-kind');
    kind.textContent = isEstimate ? 'Заявка на замер по смете' : 'Заявка с сайта';
    kind.className = `lead-badge lead-badge--${isEstimate ? 'estimate' : 'contact'}`;
    $('lead-name').textContent = lead.name || '—';
    const time = $('lead-date');
    time.textContent = formatDate(lead.created_at, longDateTimeFormat);
    time.dateTime = lead.created_at || '';

    const tel = telHref(lead.phone);
    $('lead-phone').textContent = lead.phone || '—';
    $('lead-phone-link').href = tel;
    $('lead-call').href = tel;
    const wa = whatsappNumber(lead.phone);
    const waLink = $('lead-whatsapp');
    waLink.hidden = !wa;
    waLink.href = wa ? `https://wa.me/${wa}` : '#';

    const emailLink = $('lead-email-link');
    $('lead-email').textContent = lead.email || 'Почты нет';
    if (lead.email) {
        emailLink.href = `mailto:${lead.email}`;
        emailLink.removeAttribute('aria-disabled');
    } else {
        emailLink.removeAttribute('href');
        emailLink.setAttribute('aria-disabled', 'true');
    }
    emailLink.classList.toggle('is-empty', !lead.email);

    const copyButton = $('lead-copy');
    copyButton.textContent = 'Скопировать';
    copyButton.onclick = async () => {
        const text = [lead.name, lead.phone, lead.email, lead.message].filter(Boolean).join('\n');
        try {
            await navigator.clipboard.writeText(text);
            copyButton.textContent = 'Скопировано';
            setTimeout(() => { copyButton.textContent = 'Скопировать'; }, 1500);
        } catch (e) {
            toast('Не удалось скопировать — выделите текст вручную', true);
        }
    };

    renderStatusBar(lead);
    $('lead-message').textContent = lead.message || '';

    const estimateBlock = $('lead-estimate-block');
    if (estimate.length) {
        $('lead-estimate').innerHTML = estimate.map(item => `
            <tr>
                <td>${escapeHtml(item.title)}</td>
                <td class="lead-estimate-qty">× ${escapeHtml(item.quantity)}</td>
                <td class="lead-estimate-sum">${money(item.sum)}</td>
            </tr>`).join('') + `
            <tr class="lead-estimate-total">
                <td>Ориентировочно, без выезда</td>
                <td></td>
                <td class="lead-estimate-sum">${money(lead.estimate_total)}</td>
            </tr>`;
        estimateBlock.hidden = false;
        const makeOrder = $('lead-make-order');
        makeOrder.disabled = false;
        makeOrder.dataset.id = lead.id;
        const result = $('lead-order-result');
        result.textContent = '';
        result.className = 'admin-form-message';
    } else {
        estimateBlock.hidden = true;
    }
    openModal(leadModal, null);
}

// Статус — ряд кнопок: видно текущий и меняется в один клик
function renderStatusBar(lead) {
    $('lead-status-bar').innerHTML = Object.entries(LEAD_STATUSES).map(([value, label]) => `
        <button type="button" class="lead-status-btn lead-status-btn--${value}${value === lead.status ? ' is-active' : ''}" aria-pressed="${value === lead.status}" data-id="${escapeHtml(lead.id)}" data-status="${value}">${label}</button>
    `).join('');
}

$('lead-status-bar').addEventListener('click', async event => {
    const button = event.target.closest('.lead-status-btn');
    if (!button || button.classList.contains('is-active')) return;
    const bar = button.parentElement;
    bar.querySelectorAll('.lead-status-btn').forEach(b => { b.disabled = true; });
    const { id, status } = button.dataset;
    await setLeadStatus(id, status);
    const lead = leadsCache.find(item => item.id === id);
    if (lead) renderStatusBar(lead);
    const active = bar.querySelector(`.lead-status-btn[data-status="${CSS.escape(status)}"]`);
    if (active) active.focus({ preventScroll: true });
});

$('lead-make-order').addEventListener('click', async event => {
    const button = event.currentTarget;
    const result = $('lead-order-result');
    button.disabled = true;
    result.className = 'admin-form-message';
    result.textContent = 'Создаём заказ…';
    try {
        const data = await apiJson(`${ADMIN_API}/contact-requests/${encodeURIComponent(button.dataset.id)}/order`, { method: 'POST' }, 'Не удалось создать заказ');
        result.textContent = `Заказ ${data && data.order ? data.order : ''} создан на ${money(data && data.total)}`;
        result.classList.add('is-success');
        await loadLeads();
        const lead = leadsCache.find(item => item.id === button.dataset.id);
        if (lead && modalState.current === leadModal) renderStatusBar(lead);
    } catch (err) {
        result.textContent = err.message;
        result.classList.add('is-error');
        button.disabled = false;
    }
});

// ------------------------------------------------------------------ отзывы

const REVIEW_STATUSES = { new: 'На проверке', published: 'Опубликован', rejected: 'Отклонён' };
const REVIEW_KINDS = { review: 'Отзыв', suggestion: 'Предложение' };
const REVIEW_ROW_STATE = { published: 'processed', rejected: 'spam' };
let reviewsCache = [];

function reviewRow(review) {
    const status = cssToken(review.status);
    const rating = Math.max(0, Math.min(5, Number(review.rating) || 0));
    return `
        <tr class="lead-row lead-row--${REVIEW_ROW_STATE[review.status] || 'new'}" data-id="${escapeHtml(review.id)}">
            <td data-label="Дата" class="cell-date">${dateCell(review.created_at)}</td>
            <td data-label="Тип" class="nowrap">
                ${escapeHtml(REVIEW_KINDS[review.kind] || review.kind || '—')}
                ${rating ? `<span class="cell-sub review-rating" role="img" aria-label="Оценка ${rating} из 5">${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}</span>` : ''}
            </td>
            <td data-label="Имя" class="cell-name"><span class="cell-strong">${escapeHtml(review.author_name)}</span></td>
            <td data-label="Текст"><div class="review-text">${escapeHtml(review.message)}</div></td>
            <td data-label="Контакт" class="cell-email">${review.contact ? escapeHtml(review.contact) : DASH}</td>
            <td data-label="Статус">
                <select class="lead-status-select review-status-select review-status--${status}" data-id="${escapeHtml(review.id)}" aria-label="Статус отзыва: ${escapeHtml(review.author_name)}">
                    ${statusOptions(REVIEW_STATUSES, review.status)}
                </select>
            </td>
        </tr>`;
}

async function loadReviews() {
    const tbody = $('reviews-table');
    try {
        reviewsCache = toArray(await apiJson(`${ADMIN_API}/reviews`, undefined, 'Не удалось загрузить отзывы'));
    } catch (err) {
        tbody.innerHTML = emptyRow(6, err.message, true);
        return;
    }
    updateBadge('reviews-badge', reviewsCache);
    tbody.innerHTML = reviewsCache.length ? reviewsCache.map(reviewRow).join('') : emptyRow(6, 'Пока ничего не прислали');
}

$('reviews-table').addEventListener('change', async event => {
    const select = event.target.closest('.review-status-select');
    if (!select) return;
    const id = select.dataset.id;
    const review = reviewsCache.find(item => item.id === id);
    select.disabled = true;
    try {
        await apiJson(`${ADMIN_API}/reviews/${encodeURIComponent(id)}`, jsonBody('PATCH', { status: select.value }), 'Не удалось сохранить статус');
        if (review) review.status = select.value;
    } catch (err) {
        toast(err.message, true);
    }
    if (review) {
        const row = $('reviews-table').querySelector(`tr[data-id="${CSS.escape(id)}"]`);
        if (row) row.outerHTML = reviewRow(review);
        updateBadge('reviews-badge', reviewsCache);
        const fresh = $('reviews-table').querySelector(`.review-status-select[data-id="${CSS.escape(id)}"]`);
        if (fresh) fresh.focus({ preventScroll: true });
    } else {
        loadReviews();
    }
});

// ------------------------------------------------------------------ товары и скидки

let productsCache = [];
let discountsCache = [];

// Новый бэкенд отдаёт все товары (и скрытые) через GET /api/admin/products;
// старый знает только публичный каталог.
async function fetchProducts() {
    let res = await api(`${ADMIN_API}/products`);
    if (res.status === 404 || res.status === 405) res = await request('/api/products?page_size=100');
    const data = await readJson(res);
    if (!res.ok || !Array.isArray(data)) throw new Error(errorMessage(res, data, 'Не удалось загрузить товары'));
    return data;
}

async function getProductsList() {
    if (productsCache.length) return productsCache;
    productsCache = await fetchProducts();
    fillCategoryList();
    return productsCache;
}

async function fetchDiscounts() {
    return toArray(await apiJson(`${ADMIN_API}/discounts`, undefined, 'Не удалось загрузить скидки'));
}

function fillCategoryList() {
    const categories = [...new Set(productsCache.map(p => (p.category || '').trim()).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, 'ru'));
    $('p-cat-list').innerHTML = categories.map(c => `<option value="${escapeHtml(c)}">`).join('');
}

const sameCategory = (a, b) => Boolean(a && b) && a.trim().toLowerCase() === b.trim().toLowerCase();

function productDiscount(productId) {
    return discountsCache.find(d => d.is_active && d.product_id === productId) || null;
}

function categoryDiscount(category) {
    return discountsCache
        .filter(d => d.is_active && !d.product_id && sameCategory(d.category, category))
        .sort((a, b) => b.percent_bps - a.percent_bps)[0] || null;
}

function audienceLabel(discount, short) {
    if (discount.is_registered_only === false) return short ? 'всем' : 'Всем покупателям';
    return short ? 'зарегистрированным' : 'Только зарегистрированным';
}

function discountCell(product) {
    const own = productDiscount(product.id);
    const fromCategory = categoryDiscount(product.category);
    const cell = (bps, everyone, isOwn) => {
        const scope = everyone ? 'всем' : 'зарегистрированным';
        return `<span class="nowrap">−${formatPercentBps(bps)}</span><span class="cell-sub">${isOwn ? scope : `на категорию, ${scope}`}</span>`;
    };
    // GET /api/admin/products already reports the discount the shop applies.
    const reported = Number(product.discount_percent_bps);
    if (reported > 0) {
        const everyone = product.discount_registered_only === false;
        const isOwn = !!own && own.percent_bps === reported && (own.is_registered_only === false) === everyone;
        return cell(reported, everyone, isOwn);
    }
    // Older API: same rule as the backend — discounts for everyone first, then the biggest.
    const best = [own, fromCategory].filter(Boolean).sort((a, b) =>
        (Number(b.is_registered_only === false) - Number(a.is_registered_only === false)) || (b.percent_bps - a.percent_bps))[0];
    if (!best) return DASH;
    return cell(best.percent_bps, best.is_registered_only === false, best === own);
}

function priceCell(product) {
    if (!(Number(product.price) > 0)) return '<span class="muted">по запросу</span>';
    return `${money(product.price)}${product.unit ? ` <span class="cell-sub">за ${escapeHtml(product.unit)}</span>` : ''}`;
}

function thumbCell(product) {
    const image = product.preview_image || toArray(product.images)[0];
    if (!image) return '<span class="admin-thumb admin-thumb--empty" aria-hidden="true">нет</span>';
    return `<img class="admin-thumb" src="/uploads/${encodeURIComponent(image)}" alt="" width="48" height="48" loading="lazy">`;
}

function productRow(product) {
    const badges = [];
    if (product.is_published === false) badges.push('<span class="admin-badge admin-badge--hidden">Скрыт с сайта</span>');
    return `
        <tr data-id="${escapeHtml(product.id)}">
            <td class="cell-photo">${thumbCell(product)}</td>
            <td data-label="Название" class="cell-name">
                <span class="cell-strong">${escapeHtml(product.title)}</span>
                ${product.category ? `<span class="cell-sub">${escapeHtml(product.category)}</span>` : ''}
                ${badges.length ? `<span class="cell-badges">${badges.join('')}</span>` : ''}
            </td>
            <td data-label="Цена" class="nowrap num">${priceCell(product)}</td>
            <td data-label="Наличие" class="nowrap num">${formatInt(product.stock)}</td>
            <td data-label="Скидка" class="cell-discount">${discountCell(product)}</td>
            <td data-label="Порядок" class="num">${Number.isFinite(product.sort_order) ? formatInt(product.sort_order) : DASH}</td>
            <td class="cell-actions">
                <div class="row-actions">
                    <button type="button" class="btn btn-secondary btn-sm product-edit" data-id="${escapeHtml(product.id)}" aria-label="Изменить «${escapeHtml(product.title)}»">Изменить</button>
                    <button type="button" class="btn btn-secondary btn-sm product-delete" data-id="${escapeHtml(product.id)}" aria-label="В архив «${escapeHtml(product.title)}»">В архив</button>
                </div>
            </td>
        </tr>`;
}

function renderProducts() {
    $('products-table').innerHTML = productsCache.length
        ? productsCache.map(productRow).join('')
        : emptyRow(7, 'Товаров пока нет');
}

async function loadProducts() {
    const tbody = $('products-table');
    try {
        const [products, discounts] = await Promise.all([fetchProducts(), fetchDiscounts().catch(() => null)]);
        productsCache = products;
        if (discounts) discountsCache = discounts;
    } catch (err) {
        tbody.innerHTML = emptyRow(7, err.message, true);
        return;
    }
    fillCategoryList();
    renderProducts();
}

// Битая картинка в таблице → заглушка вместо пустого квадрата
$('products-table').addEventListener('error', event => {
    const img = event.target;
    if (img.tagName !== 'IMG' || !img.classList.contains('admin-thumb')) return;
    const placeholder = document.createElement('span');
    placeholder.className = 'admin-thumb admin-thumb--empty';
    placeholder.setAttribute('aria-hidden', 'true');
    placeholder.textContent = 'нет';
    img.replaceWith(placeholder);
}, true);

$('products-table').addEventListener('click', async event => {
    const editButton = event.target.closest('.product-edit');
    const deleteButton = event.target.closest('.product-delete');
    if (editButton) {
        const product = productsCache.find(item => item.id === editButton.dataset.id);
        if (product) openProductModal(product);
        return;
    }
    if (!deleteButton) return;
    const product = productsCache.find(item => item.id === deleteButton.dataset.id);
    const name = product ? `«${product.title}»` : 'товар';
    if (!confirm(`Убрать ${name} в архив? Он пропадёт из каталога.`)) return;
    deleteButton.disabled = true;
    try {
        await apiJson(`${ADMIN_API}/products/${encodeURIComponent(deleteButton.dataset.id)}`, { method: 'DELETE' }, 'Не удалось убрать товар в архив');
        toast('Товар убран в архив');
        loadProducts();
    } catch (err) {
        toast(err.message, true);
        deleteButton.disabled = false;
    }
});

// --- окно товара

const productModal = $('product-modal');
const productForm = $('product-form');
const productSubmit = $('product-submit');
const productError = $('product-form-error');
let editingProductId = null;
let savingProduct = false;

function setProductMode(product) {
    editingProductId = product ? product.id : null;
    $('product-modal-title').textContent = product ? 'Редактировать товар' : 'Новый товар';
    productSubmit.textContent = product ? 'Сохранить' : 'Создать товар';
}

function showProductError(message, fieldId) {
    productError.textContent = message || '';
    productForm.querySelectorAll('[aria-invalid="true"]').forEach(el => el.removeAttribute('aria-invalid'));
    if (fieldId) {
        const field = $(fieldId);
        field.setAttribute('aria-invalid', 'true');
        field.focus();
    }
}

function openProductModal(product) {
    productForm.reset();
    showProductError('');
    resetSelectedImages();
    setProductMode(product);
    if (product) {
        $('p-title').value = product.title || '';
        $('p-desc').value = product.description || '';
        $('p-price').value = Number(product.price) > 0 ? String(product.price / 100) : '';
        $('p-unit').value = product.unit || '';
        $('p-cat').value = product.category || '';
        $('p-stock').value = Number.isFinite(product.stock) ? product.stock : 0;
        $('p-sort').value = Number.isFinite(product.sort_order) ? product.sort_order : '';
        const own = productDiscount(product.id);
        $('p-discount').value = own ? own.percent_bps / 100 : '';
        $('p-discount-registered').checked = own ? own.is_registered_only !== false : true;
        showCurrentImages(toArray(product.images).length ? product.images : (product.preview_image ? [product.preview_image] : []));
    } else {
        showCurrentImages([]);
    }
    openModal(productModal, $('p-title'));
}

$('open-modal').addEventListener('click', () => openProductModal(null));

function readNumber(id) {
    const input = $(id);
    if (input.validity && input.validity.badInput) return { bad: true };
    const raw = input.value.trim().replace(',', '.');
    if (raw === '') return { empty: true };
    const value = Number(raw);
    return Number.isFinite(value) ? { value } : { bad: true };
}

function readProductForm() {
    const title = $('p-title').value.trim();
    if (!title) return { error: 'Укажите название товара', field: 'p-title' };
    if (title.length > 200) return { error: 'Название длиннее 200 символов', field: 'p-title' };

    const price = readNumber('p-price');
    if (price.bad || (!price.empty && price.value < 0)) return { error: 'Цена — число от 0. Пусто или 0 — «по запросу».', field: 'p-price' };

    const stock = readNumber('p-stock');
    if (stock.bad || (!stock.empty && (stock.value < 0 || !Number.isInteger(stock.value)))) {
        return { error: 'Количество — целое число от 0', field: 'p-stock' };
    }

    const sort = readNumber('p-sort');
    if (sort.bad || (!sort.empty && (!Number.isInteger(sort.value) || Math.abs(sort.value) > 1000000))) {
        return { error: 'Порядок — целое число, например 10, 20, 30', field: 'p-sort' };
    }

    const discount = readNumber('p-discount');
    if (discount.bad || (!discount.empty && (discount.value < 0 || discount.value >= 100))) {
        return { error: 'Скидка — от 0,01 до 99,99 %. Пусто или 0 — без скидки.', field: 'p-discount' };
    }

    return {
        title,
        description: $('p-desc').value.trim(),
        price: price.empty ? 0 : Math.round(price.value * 100),
        category: $('p-cat').value.trim(),
        unit: $('p-unit').value.trim(),
        stock: stock.empty ? 0 : stock.value,
        sortOrder: sort.empty ? null : sort.value,
        discount: !discount.empty && discount.value > 0
            ? { percent: Math.round(discount.value * 100) / 100, registeredOnly: $('p-discount-registered').checked }
            : null
    };
}

async function syncProductDiscount(productId, wanted) {
    const discounts = await fetchDiscounts();
    const own = discounts.filter(d => d.is_active && d.product_id === productId);
    const keep = wanted && own.find(d => d.percent_bps === Math.round(wanted.percent * 100)
        && (d.is_registered_only !== false) === wanted.registeredOnly);
    for (const discount of own) {
        if (discount === keep) continue;
        await apiJson(`${ADMIN_API}/discounts/${encodeURIComponent(discount.id)}`, { method: 'DELETE' }, 'Не удалось отключить прежнюю скидку');
    }
    if (wanted && !keep) {
        await apiJson(`${ADMIN_API}/discounts`, jsonBody('POST', {
            product_id: productId,
            percent: wanted.percent,
            is_registered_only: wanted.registeredOnly
        }), 'Не удалось сохранить скидку');
    }
}

function setSaving(on) {
    savingProduct = on;
    productSubmit.disabled = on || imageJobs > 0;
    if (on) productSubmit.textContent = editingProductId ? 'Сохраняем…' : 'Создаём…';
    else productSubmit.textContent = editingProductId ? 'Сохранить' : 'Создать товар';
}

productForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (savingProduct || imageJobs > 0) return;
    const values = readProductForm();
    if (values.error) {
        showProductError(values.error, values.field);
        return;
    }
    showProductError('');
    const wasEditing = Boolean(editingProductId);
    setSaving(true);
    let step = '';
    try {
        let productId = editingProductId;
        if (productId) {
            const body = {
                title: values.title,
                description: values.description,
                price: values.price,
                category: values.category,
                unit: values.unit,
                stock: values.stock
            };
            if (values.sortOrder !== null) body.sort_order = values.sortOrder;
            await apiJson(`${ADMIN_API}/products/${encodeURIComponent(productId)}`, jsonBody('PUT', body), 'Не удалось сохранить товар');
            if (selectedImages.length) {
                step = 'Данные товара сохранены, но фото не загрузились: ';
                const imagesForm = new FormData();
                selectedImages.forEach(item => imagesForm.append('images', item.file, item.file.name));
                const updated = await apiJson(`${ADMIN_API}/products/${encodeURIComponent(productId)}/images`, { method: 'POST', body: imagesForm }, 'Не удалось загрузить фото');
                resetSelectedImages();
                showCurrentImages(toArray(updated && updated.images));
            }
        } else {
            const form = new FormData();
            form.append('title', values.title);
            form.append('description', values.description);
            form.append('price', String(values.price));
            form.append('category', values.category);
            form.append('unit', values.unit);
            form.append('stock', String(values.stock));
            if (values.sortOrder !== null) form.append('sort_order', String(values.sortOrder));
            selectedImages.forEach(item => form.append('images', item.file, item.file.name));
            const created = await apiJson(`${ADMIN_API}/products`, { method: 'POST', body: form }, 'Не удалось создать товар');
            productId = created && created.id;
            if (!productId) throw new Error('Сервер не вернул созданный товар — обновите список и проверьте.');
            // Повторное нажатие после ошибки не должно создать дубль: дальше — режим редактирования
            setProductMode(created);
            resetSelectedImages();
            showCurrentImages(toArray(created.images));
        }
        step = wasEditing ? 'Товар сохранён, но скидка не применилась: ' : 'Товар создан, но скидка не применилась: ';
        await syncProductDiscount(productId, values.discount);
        closeModal({ force: true });
        toast(wasEditing ? 'Товар сохранён' : 'Товар создан');
        loadProducts();
    } catch (err) {
        showProductError(step + err.message);
        if (!wasEditing && editingProductId) loadProducts();
    } finally {
        setSaving(false);
    }
});

// --- фото товара: проверка, сжатие, превью

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const RECODE_ABOVE_BYTES = 1.5 * 1024 * 1024;
const MAX_IMAGE_SIDE = 1920;
const dropZone = $('drop-zone');
const fileInput = $('product-images');
const imageStatus = $('image-status');
let selectedImages = [];
let imageJobs = 0;
let imageGeneration = 0;

function setImageStatus(message, isError) {
    imageStatus.textContent = message || '';
    imageStatus.hidden = !message;
    imageStatus.classList.toggle('is-error', Boolean(isError));
}

function resetSelectedImages() {
    imageGeneration++;
    selectedImages.forEach(item => URL.revokeObjectURL(item.url));
    selectedImages = [];
    imageJobs = 0;
    productSubmit.disabled = savingProduct;
    setImageStatus('');
    renderPreview();
}

async function decodeImage(file) {
    if (typeof createImageBitmap === 'function') {
        try {
            const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
            return { image: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
        } catch (e) { /* пробуем через <img> */ }
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    try {
        await img.decode();
    } catch (e) {
        URL.revokeObjectURL(url);
        throw e;
    }
    return { image: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
}

function canvasToBlob(canvas, quality) {
    return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
}

async function recodeToJpeg(file) {
    const source = await decodeImage(file);
    try {
        if (!source.width || !source.height) throw new Error('empty image');
        const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(source.width, source.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(source.width * scale));
        canvas.height = Math.max(1, Math.round(source.height * scale));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff'; // прозрачный PNG в JPEG — на белом, а не на чёрном
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(source.image, 0, 0, canvas.width, canvas.height);
        let blob = await canvasToBlob(canvas, 0.85);
        if (blob && blob.size > MAX_IMAGE_BYTES) blob = await canvasToBlob(canvas, 0.7);
        if (!blob) throw new Error('toBlob failed');
        return blob;
    } finally {
        source.release();
    }
}

// JPEG/PNG/WebP до 1,5 МБ уходят как есть; остальное (большие фото, HEIC,
// GIF и т. п.) пережимается в JPEG до 1920 px по длинной стороне.
async function prepareImage(file) {
    const allowed = ALLOWED_IMAGE_TYPES.includes(file.type);
    const acceptableAsIs = allowed && file.size <= MAX_IMAGE_BYTES;
    if (allowed && file.size <= RECODE_ABOVE_BYTES) return file;
    if (file.type && !file.type.startsWith('image/')) throw new Error('это не изображение');
    let blob;
    try {
        blob = await recodeToJpeg(file);
    } catch (e) {
        if (acceptableAsIs) return file;
        throw new Error('браузер не смог открыть этот формат — сохраните фото как JPEG или PNG');
    }
    if (acceptableAsIs && blob.size >= file.size) return file;
    if (blob.size > MAX_IMAGE_BYTES) throw new Error('больше 5 МБ даже после сжатия');
    const name = (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg';
    return new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() });
}

async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const generation = imageGeneration;
    const problems = [];
    if (selectedImages.length + files.length > MAX_IMAGES) {
        problems.push(`Можно не больше ${MAX_IMAGES} фото — лишние не добавлены.`);
    }
    imageJobs++;
    productSubmit.disabled = true;
    setImageStatus('Готовим фото…');
    for (const file of files) {
        if (generation !== imageGeneration) return;
        if (selectedImages.length >= MAX_IMAGES) break;
        try {
            const prepared = await prepareImage(file);
            if (generation !== imageGeneration) return;
            if (selectedImages.length >= MAX_IMAGES) break;
            selectedImages.push({ file: prepared, url: URL.createObjectURL(prepared) });
            renderPreview();
        } catch (err) {
            problems.push(`«${file.name}»: ${err.message}.`);
        }
    }
    if (generation !== imageGeneration) return;
    imageJobs = Math.max(0, imageJobs - 1);
    productSubmit.disabled = savingProduct || imageJobs > 0;
    setImageStatus(problems.join(' '), problems.length > 0);
}

function showCurrentImages(images) {
    const note = $('current-images-note');
    const box = $('current-images');
    const list = toArray(images);
    box.innerHTML = list.map((img, i) => `
        <div class="preview-item preview-item--current${i === 0 ? ' preview-main' : ''}">
            <img src="/uploads/${encodeURIComponent(img)}" alt="Текущее фото ${i + 1}">
            ${i === 0 ? '<span class="preview-cover">Обложка</span>' : ''}
        </div>
    `).join('');
    box.dataset.count = String(list.length);
    updateImagesNote();
    note.hidden = !list.length;
}

function updateImagesNote() {
    const note = $('current-images-note');
    const count = Number($('current-images').dataset.count || 0);
    if (!count) return;
    note.textContent = selectedImages.length
        ? `Текущие фото (${count}) будут заменены новыми при сохранении.`
        : `Текущие фото (${count}). Если выбрать новые, они полностью заменят эти.`;
}

const REMOVE_ICON = '<svg class="icon" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>';

function renderPreview() {
    $('image-preview').innerHTML = selectedImages.map((item, i) => `
        <div class="preview-item${i === 0 ? ' preview-main' : ''}">
            <img src="${escapeHtml(item.url)}" alt="Новое фото ${i + 1}">
            ${i === 0 ? '<span class="preview-cover">Обложка</span>' : ''}
            <button type="button" class="preview-remove" data-index="${i}" aria-label="Убрать новое фото ${i + 1}">${REMOVE_ICON}</button>
        </div>
    `).join('');
    updateImagesNote();
}

$('image-preview').addEventListener('click', event => {
    const button = event.target.closest('.preview-remove');
    if (!button) return;
    const index = Number(button.dataset.index);
    const [removed] = selectedImages.splice(index, 1);
    if (removed) URL.revokeObjectURL(removed.url);
    renderPreview();
    const next = $('image-preview').querySelectorAll('.preview-remove')[Math.min(index, selectedImages.length - 1)];
    (next || fileInput).focus();
});

fileInput.addEventListener('change', () => {
    addFiles(fileInput.files);
    fileInput.value = '';
});
dropZone.addEventListener('dragover', event => {
    event.preventDefault();
    dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', event => {
    if (!dropZone.contains(event.relatedTarget)) dropZone.classList.remove('dragover');
});
dropZone.addEventListener('drop', event => {
    event.preventDefault();
    dropZone.classList.remove('dragover');
    addFiles(event.dataTransfer && event.dataTransfer.files);
});
// Фото, брошенное мимо зоны, не должно открываться вместо админки
['dragover', 'drop'].forEach(type => document.addEventListener(type, event => {
    if (modalState.current === productModal && !dropZone.contains(event.target)) event.preventDefault();
}));

// --- раздел «Скидки»

function discountTarget(discount) {
    if (discount.product_id) {
        const product = productsCache.find(item => item.id === discount.product_id);
        return `<span class="cell-strong">${escapeHtml(product ? product.title : 'Товар не в каталоге')}</span><span class="cell-sub">товар</span>`;
    }
    return `<span class="cell-strong">${escapeHtml(discount.category || '—')}</span><span class="cell-sub">категория</span>`;
}

function discountPeriod(discount) {
    const parts = [];
    if (discount.starts_at) parts.push(`с ${formatDate(discount.starts_at, dateFormat)}`);
    if (discount.ends_at) parts.push(`до ${formatDate(discount.ends_at, dateFormat)}`);
    return parts.length ? `<span class="cell-sub">${parts.join(' ')}</span>` : '';
}

function renderDiscounts() {
    const active = discountsCache.filter(d => d.is_active);
    $('discounts-table').innerHTML = active.length ? active.map(discount => `
        <tr>
            <td data-label="На что" class="cell-name">${discountTarget(discount)}</td>
            <td data-label="Скидка" class="nowrap num">−${formatPercentBps(discount.percent_bps)}${discountPeriod(discount)}</td>
            <td data-label="Для кого">${audienceLabel(discount, false)}</td>
            <td class="cell-actions"><div class="row-actions"><button type="button" class="btn btn-secondary btn-sm discount-delete" data-id="${escapeHtml(discount.id)}">Отключить</button></div></td>
        </tr>
    `).join('') : emptyRow(4, 'Действующих скидок нет');
}

async function loadDiscounts() {
    const tbody = $('discounts-table');
    try {
        const [discounts] = await Promise.all([fetchDiscounts(), getProductsList().catch(() => [])]);
        discountsCache = discounts;
    } catch (err) {
        tbody.innerHTML = emptyRow(4, err.message, true);
        return;
    }
    renderDiscounts();
}

$('discounts-table').addEventListener('click', async event => {
    const button = event.target.closest('.discount-delete');
    if (!button || !confirm('Отключить эту скидку?')) return;
    button.disabled = true;
    try {
        await apiJson(`${ADMIN_API}/discounts/${encodeURIComponent(button.dataset.id)}`, { method: 'DELETE' }, 'Не удалось отключить скидку');
        toast('Скидка отключена');
        loadDiscounts();
    } catch (err) {
        toast(err.message, true);
        button.disabled = false;
    }
});

$('discount-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const message = $('discount-form-message');
    const button = form.querySelector('button[type="submit"]');
    const categoryInput = $('d-category');
    const percentInput = $('d-percent');
    [categoryInput, percentInput].forEach(el => el.removeAttribute('aria-invalid'));
    message.className = 'admin-form-message is-error';
    const category = categoryInput.value.trim();
    if (!category) {
        message.textContent = 'Укажите категорию';
        categoryInput.setAttribute('aria-invalid', 'true');
        categoryInput.focus();
        return;
    }
    const percent = readNumber('d-percent');
    if (percent.bad || percent.empty || percent.value <= 0 || percent.value >= 100) {
        message.textContent = 'Скидка — от 0,01 до 99,99 %';
        percentInput.setAttribute('aria-invalid', 'true');
        percentInput.focus();
        return;
    }
    button.disabled = true;
    message.className = 'admin-form-message';
    message.textContent = 'Сохраняем…';
    try {
        await apiJson(`${ADMIN_API}/discounts`, jsonBody('POST', {
            category,
            percent: Math.round(percent.value * 100) / 100,
            is_registered_only: $('d-registered-only').checked
        }), 'Не удалось добавить скидку');
        form.reset();
        message.className = 'admin-form-message is-success';
        message.textContent = `Скидка на «${category}» добавлена`;
        loadDiscounts();
    } catch (err) {
        message.className = 'admin-form-message is-error';
        message.textContent = err.message;
    } finally {
        button.disabled = false;
    }
});

// ------------------------------------------------------------------ заказы

const ORDER_STATUSES = {
    pending: 'Новый',
    pending_payment: 'Ожидает оплаты',
    awaiting_payment: 'Ожидает оплаты',
    paid: 'Оплачен',
    processing: 'В работе',
    fulfilled: 'Выполнен',
    expired: 'Не оплачен в срок',
    cancelled: 'Отменён',
    refunded: 'Возврат'
};
const PAYMENT_METHODS = { sbp: 'СБП', invoice: 'Счёт' };

function orderRow(order) {
    const status = cssToken(order.status);
    const method = PAYMENT_METHODS[order.payment_method];
    const number = order.public_number || ('#' + String(order.id || '').slice(0, 8));
    const companyName = order.company_name && order.company_name.trim() !== String(order.customer_name || '').trim() ? order.company_name : '';
    const company = [companyName, order.company_inn ? `ИНН ${order.company_inn}` : ''].filter(Boolean).join(', ');
    return `
        <tr>
            <td data-label="Номер" class="nowrap"><span class="cell-strong">${escapeHtml(number)}</span></td>
            <td data-label="Клиент" class="cell-name">
                <span class="cell-strong">${escapeHtml(order.customer_name)}</span>
                ${company ? `<span class="cell-sub">${escapeHtml(company)}</span>` : ''}
                <span class="cell-links">
                    ${order.customer_phone ? `<a href="${escapeHtml(telHref(order.customer_phone))}" class="inline-link tap-link">${escapeHtml(order.customer_phone)}</a>` : ''}
                    ${order.customer_email ? `<a href="mailto:${escapeHtml(order.customer_email)}" class="inline-link tap-link">${escapeHtml(order.customer_email)}</a>` : ''}
                </span>
                ${order.customer_address ? `<span class="cell-sub">${escapeHtml(order.customer_address)}</span>` : ''}
            </td>
            <td data-label="Сумма" class="nowrap num">${money(order.total_amount)}</td>
            <td data-label="Оплата">${method ? `<span class="admin-badge admin-badge--${cssToken(order.payment_method)}">${method}</span>` : DASH}</td>
            <td data-label="Статус"><span class="order-status order-status--${status}">${escapeHtml(ORDER_STATUSES[order.status] || order.status || '—')}</span></td>
            <td data-label="Дата" class="cell-date">${dateCell(order.created_at)}</td>
        </tr>`;
}

async function loadOrders() {
    const tbody = $('orders-table');
    let orders;
    try {
        orders = toArray(await apiJson(`${ADMIN_API}/orders`, undefined, 'Не удалось загрузить заказы'));
    } catch (err) {
        tbody.innerHTML = emptyRow(6, err.message, true);
        return;
    }
    tbody.innerHTML = orders.length ? orders.map(orderRow).join('') : emptyRow(6, 'Заказов пока нет');
}

// ------------------------------------------------------------------ разделы

const SECTION_LOADERS = {
    dashboard: loadDashboard,
    leads: loadLeads,
    reviews: loadReviews,
    products: loadProducts,
    discounts: loadDiscounts,
    orders: loadOrders
};
const navLinks = [...document.querySelectorAll('#admin-nav a[href^="#"]')];
let firstSwitch = true;

function revealNavLink(link) {
    const nav = link.parentElement;
    if (nav.scrollWidth <= nav.clientWidth + 1) return;
    const left = link.offsetLeft - (nav.clientWidth - link.offsetWidth) / 2;
    nav.scrollTo({ left: Math.max(0, left), behavior: firstSwitch ? 'auto' : 'smooth' });
}

function refreshBadges(activeId) {
    if (activeId !== 'leads') {
        api(`${ADMIN_API}/contact-requests`).then(r => (r.ok ? r.json() : null)).then(items => {
            if (items) updateBadge('leads-badge', items);
        }).catch(() => {});
    }
    if (activeId !== 'reviews') {
        api(`${ADMIN_API}/reviews`).then(r => (r.ok ? r.json() : null)).then(items => {
            if (items) updateBadge('reviews-badge', items);
        }).catch(() => {});
    }
}

function switchAdminSection() {
    const requested = location.hash.slice(1);
    const activeId = Object.prototype.hasOwnProperty.call(SECTION_LOADERS, requested) ? requested : 'dashboard';
    closeModal({ restoreFocus: false });
    document.querySelectorAll('.admin-section').forEach(section => {
        section.hidden = section.id !== activeId;
    });
    navLinks.forEach(link => {
        const active = link.getAttribute('href') === `#${activeId}`;
        link.classList.toggle('active', active);
        if (active) {
            link.setAttribute('aria-current', 'page');
            revealNavLink(link);
        } else {
            link.removeAttribute('aria-current');
        }
    });
    const heading = document.querySelector(`#${activeId} h2`);
    document.title = `${heading ? heading.textContent : 'Админ-панель'} — Админ-панель ГраутПро`;
    if (!firstSwitch) window.scrollTo(0, 0);
    firstSwitch = false;
    Promise.resolve(SECTION_LOADERS[activeId]()).catch(err => toast(err.message || 'Не удалось загрузить раздел', true));
    refreshBadges(activeId);
}

$('admin-logout').addEventListener('click', () => goToLogin(false));

if (token) {
    window.addEventListener('hashchange', switchAdminSection);
    switchAdminSection();
} else {
    goToLogin(false);
}
