// Работы считаются за пог. м / м² / ввод; «шт» остаётся только у штучных позиций
const unitSuffix = product => (product.unit ? ' / ' + product.unit : '');
const isService = product => (product.unit && product.unit !== 'шт') || !(product.price > 0);
const money = value => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(value / 100);
(() => {
  const grid = document.getElementById('shop-grid');
  const search = document.getElementById('shop-search');
  const category = document.getElementById('shop-category');
  const sort = document.getElementById('shop-sort');
  const reset = document.getElementById('shop-reset');
  const resultCount = document.getElementById('shop-result-count');
  let products = [];
  let debounceTimer;
  let isRegistered = false;

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

  function finalPrice(product) {
    if (!(product.discount_percent_bps > 0)) return product.price;
    return Math.floor(product.price * (10000 - product.discount_percent_bps) / 10000);
  }

  async function checkAuth() {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
      isRegistered = res.ok;
    } catch {
      isRegistered = false;
    }
  }

  // Native <option> popups render with the browser's own chrome and ignore most
  // theme CSS, so the visible dropdown is built here instead. The real <select>
  // (hidden) keeps holding the value so the rest of this file doesn't change.
  function initCustomSelect(selectEl) {
    const root = document.querySelector(`.custom-select[data-for="${selectEl.id}"]`);
    if (!root) return () => {};
    const trigger = root.querySelector('.custom-select-trigger');
    const label = root.querySelector('.custom-select-label');
    const list = root.querySelector('.custom-select-list');

    function close() {
      root.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
      list.hidden = true;
    }
    function open() {
      document.querySelectorAll('.custom-select.is-open').forEach(el => { if (el !== root) el.querySelector('.custom-select-trigger').click(); });
      root.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
      list.hidden = false;
    }
    function syncLabel() {
      const selected = selectEl.options[selectEl.selectedIndex];
      label.textContent = selected ? selected.textContent : '';
      list.querySelectorAll('.custom-select-option').forEach(li => {
        li.setAttribute('aria-selected', String(li.dataset.value === selectEl.value));
      });
    }
    function rebuild() {
      list.innerHTML = '';
      [...selectEl.options].forEach(opt => {
        const li = document.createElement('li');
        li.className = 'custom-select-option';
        li.setAttribute('role', 'option');
        li.dataset.value = opt.value;
        li.textContent = opt.textContent;
        li.addEventListener('click', () => {
          selectEl.value = opt.value;
          selectEl.dispatchEvent(new Event('input', { bubbles: true }));
          syncLabel();
          close();
        });
        list.appendChild(li);
      });
      syncLabel();
    }

    trigger.addEventListener('click', () => { root.classList.contains('is-open') ? close() : open(); });
    document.addEventListener('click', (e) => { if (!root.contains(e.target)) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

    rebuild();
    return { rebuild, syncLabel };
  }

  function updateUrl() {
    const params = new URLSearchParams();
    if (search.value.trim()) params.set('q', search.value.trim());
    if (category.value) params.set('category', category.value);
    if (sort.value !== 'newest') params.set('sort', sort.value);
    history.replaceState(null, '', `${location.pathname}${params.toString() ? `?${params}` : ''}`);
  }

  function render(items = products) {
    resultCount.textContent = items.length ? `Найдено товаров: ${items.length}` : '';
    if (!items.length) {
      grid.innerHTML = '<p class="shop-empty">По вашему запросу товары не найдены</p>';
      return;
    }
    grid.innerHTML = items.map(product => {
      const hasDiscount = product.discount_percent_bps > 0;
      const appliesNow = hasDiscount && (!product.discount_registered_only || isRegistered);
      let priceRow;
      if (appliesNow) {
        priceRow = `<div class="shop-price-row">
             <span class="shop-price">${isService(product) ? 'от ' : ''}${money(finalPrice(product))}${unitSuffix(product)}</span>
             <span class="shop-price-old">${money(product.price)}</span>
             <span class="shop-discount-badge">-${product.discount_percent_bps / 100}%</span>
           </div>`;
      } else if (hasDiscount) {
        priceRow = `<div class="shop-price-row">
             <span class="shop-price">${isService(product) ? 'от ' : ''}${money(product.price)}${unitSuffix(product)}</span>
             <span class="shop-discount-badge">-${product.discount_percent_bps / 100}% для зарегистрированных</span>
           </div>`;
      } else {
        priceRow = product.price > 0
          ? `<div class="shop-price-row"><span class="shop-price">${isService(product) ? 'от ' : ''}${money(product.price)}${unitSuffix(product)}</span></div>`
          : `<div class="shop-price-row"><span class="shop-price shop-price--quote">Цена по запросу</span></div>`;
      }
      return `
      <a href="product.html?id=${encodeURIComponent(product.id)}" class="shop-card glass">
        ${product.preview_image
          ? `<img class="shop-image" src="/uploads/${encodeURIComponent(product.preview_image)}" alt="${escapeHtml(product.title)}" loading="lazy">`
          : `<div class="shop-image shop-image--empty"><span>Фото скоро</span></div>`}
        <div class="shop-info">
          <h3>${escapeHtml(product.title)}</h3>
          ${product.category ? `<span class="shop-category">${escapeHtml(product.category)}</span>` : ''}
          ${priceRow}
          <p class="shop-stock">${isService(product) ? 'Стоимость — после замера' : (product.stock > 0 ? 'В наличии' : 'Нет в наличии')}</p>
        </div>
      </a>
    `;
    }).join('');
  }

  function syncFromUrl() {
    const params = new URLSearchParams(location.search);
    search.value = params.get('q') || '';
    category.value = params.get('category') || '';
    sort.value = params.get('sort') || 'newest';
  }

  async function loadProducts() {
    try {
      const response = await fetch('/api/products?page_size=100');
      if (!response.ok) throw new Error('catalog request failed');
      products = await response.json();
      const seen = new Map();
      products.forEach(product => {
        const raw = (product.category || '').trim();
        if (!raw) return;
        const key = raw.toLowerCase();
        if (!seen.has(key)) seen.set(key, raw);
      });
      [...seen.values()].sort((a, b) => a.localeCompare(b, 'ru')).forEach(value => {
        category.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`);
      });
      categoryWidget.rebuild();
      syncFromUrl();
      categoryWidget.syncLabel();
      sortWidget.syncLabel();
      await loadFilteredProducts();
    } catch {
      grid.innerHTML = '<p class="shop-empty">Не удалось загрузить каталог. Попробуйте обновить страницу.</p>';
    }
  }

  async function loadFilteredProducts() {
    const params = new URLSearchParams({ page_size: '100' });
    if (search.value.trim()) params.set('q', search.value.trim());
    if (category.value) params.set('category', category.value);
    if (sort.value !== 'newest') params.set('sort', sort.value);
    grid.innerHTML = '<p class="shop-empty">Загрузка товаров...</p>';
    try {
      const response = await fetch(`/api/products?${params}`);
      if (!response.ok) throw new Error('catalog request failed');
      render(await response.json());
    } catch {
      grid.innerHTML = '<p class="shop-empty">Не удалось загрузить каталог. Попробуйте обновить страницу.</p>';
    }
  }

  [search, category, sort].forEach(control => control.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { updateUrl(); loadFilteredProducts(); }, 200);
  }));
  reset.addEventListener('click', () => {
    search.value = '';
    category.value = '';
    sort.value = 'newest';
    categoryWidget.syncLabel();
    sortWidget.syncLabel();
    updateUrl();
    loadFilteredProducts();
  });
  const categoryWidget = initCustomSelect(category);
  const sortWidget = initCustomSelect(sort);
  checkAuth().then(loadProducts);
})();
