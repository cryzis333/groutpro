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

  // Native <option> popups render with the browser's own chrome and ignore most theme CSS,
  // so the visible dropdown is an ARIA listbox built here (mouse, touch and keyboard:
  // arrows, Home/End, Enter/Space, Esc, type-ahead). The real <select> (hidden) keeps
  // holding the value, so the rest of this file reads it as before.
  const openWidgets = new Set();

  function initCustomSelect(selectEl) {
    const root = document.querySelector(`.custom-select[data-for="${selectEl.id}"]`);
    if (!root) return { rebuild() {}, syncLabel() {} };
    const trigger = root.querySelector('.custom-select-trigger');
    const label = root.querySelector('.custom-select-label');
    const list = root.querySelector('.custom-select-list');
    const caption = root.parentElement.querySelector('.shop-filter-label');

    const listId = `${selectEl.id}-listbox`;
    trigger.id = trigger.id || `${selectEl.id}-trigger`;
    list.id = listId;
    trigger.setAttribute('aria-controls', listId);
    if (caption) {
      caption.id = caption.id || `${selectEl.id}-caption`;
      trigger.setAttribute('aria-labelledby', `${caption.id} ${trigger.id}`);
      list.setAttribute('aria-labelledby', caption.id);
      // Clicking the caption focuses the control, like a <label> would (without re-opening it)
      caption.addEventListener('click', () => trigger.focus());
    }

    let activeIndex = -1;
    let typeahead = '';
    let typeaheadTimer;
    const options = () => [...list.querySelectorAll('.custom-select-option')];
    const isOpen = () => root.classList.contains('is-open');

    function setActive(index) {
      const items = options();
      if (!items.length) return;
      activeIndex = Math.max(0, Math.min(index, items.length - 1));
      items.forEach((li, i) => li.classList.toggle('is-active', i === activeIndex));
      const active = items[activeIndex];
      list.setAttribute('aria-activedescendant', active.id);
      // keep the active option visible inside the scrollable list
      if (active.offsetTop < list.scrollTop) list.scrollTop = active.offsetTop - 6;
      else if (active.offsetTop + active.offsetHeight > list.scrollTop + list.clientHeight) {
        list.scrollTop = active.offsetTop + active.offsetHeight - list.clientHeight + 6;
      }
    }

    function close(focusTrigger) {
      if (!isOpen()) return;
      root.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
      list.hidden = true;
      list.removeAttribute('aria-activedescendant');
      openWidgets.delete(close);
      if (focusTrigger) trigger.focus();
    }

    function open() {
      openWidgets.forEach(closeOther => closeOther(false));
      root.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
      list.hidden = false;
      openWidgets.add(close);
      setActive(Math.max(0, selectEl.selectedIndex));
      list.focus({ preventScroll: true });
    }

    function choose(index) {
      const opt = selectEl.options[index];
      if (opt && selectEl.value !== opt.value) {
        selectEl.value = opt.value;
        selectEl.dispatchEvent(new Event('input', { bubbles: true }));
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
      syncLabel();
      close(true);
    }

    function syncLabel() {
      const selected = selectEl.options[selectEl.selectedIndex];
      label.textContent = selected ? selected.textContent : '';
      options().forEach(li => {
        li.setAttribute('aria-selected', String(li.dataset.value === selectEl.value));
      });
    }

    function rebuild() {
      list.innerHTML = '';
      [...selectEl.options].forEach((opt, i) => {
        const li = document.createElement('li');
        li.className = 'custom-select-option';
        li.id = `${listId}-opt-${i}`;
        li.setAttribute('role', 'option');
        li.dataset.value = opt.value;
        li.textContent = opt.textContent;
        list.appendChild(li);
      });
      syncLabel();
    }

    trigger.addEventListener('click', () => { isOpen() ? close(false) : open(); });
    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        open();
      }
    });

    list.addEventListener('click', (e) => {
      const li = e.target.closest('.custom-select-option');
      if (li) choose(options().indexOf(li));
    });
    list.addEventListener('mousemove', (e) => {
      const li = e.target.closest('.custom-select-option');
      if (li) {
        const i = options().indexOf(li);
        if (i !== activeIndex) setActive(i);
      }
    });
    list.addEventListener('keydown', (e) => {
      const count = options().length;
      switch (e.key) {
        case 'ArrowDown': e.preventDefault(); setActive(activeIndex + 1); break;
        case 'ArrowUp': e.preventDefault(); setActive(activeIndex - 1); break;
        case 'Home': e.preventDefault(); setActive(0); break;
        case 'End': e.preventDefault(); setActive(count - 1); break;
        case 'PageDown': e.preventDefault(); setActive(activeIndex + 5); break;
        case 'PageUp': e.preventDefault(); setActive(activeIndex - 5); break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          if (activeIndex >= 0) choose(activeIndex);
          break;
        case 'Escape': e.preventDefault(); e.stopPropagation(); close(true); break;
        case 'Tab': close(false); break;
        default:
          if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            clearTimeout(typeaheadTimer);
            typeahead += e.key.toLowerCase();
            typeaheadTimer = setTimeout(() => { typeahead = ''; }, 600);
            const items = options();
            const start = typeahead.length === 1 ? activeIndex + 1 : activeIndex;
            for (let n = 0; n < items.length; n++) {
              const i = (start + n) % items.length;
              if (items[i].textContent.trim().toLowerCase().startsWith(typeahead)) { setActive(i); break; }
            }
          }
      }
    });
    list.addEventListener('focusout', (e) => {
      if (!root.contains(e.relatedTarget)) close(false);
    });
    document.addEventListener('click', (e) => { if (!root.contains(e.target)) close(false); });

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
      const unit = escapeHtml(unitSuffix(product));
      let priceRow;
      if (appliesNow) {
        priceRow = `<div class="shop-price-row">
             <span class="shop-price">${isService(product) ? 'от ' : ''}${money(finalPrice(product))}${unit}</span>
             <span class="shop-price-old">${money(product.price)}</span>
             <span class="shop-discount-badge">-${product.discount_percent_bps / 100}%</span>
           </div>`;
      } else if (hasDiscount) {
        priceRow = `<div class="shop-price-row">
             <span class="shop-price">${isService(product) ? 'от ' : ''}${money(product.price)}${unit}</span>
             <span class="shop-discount-badge">-${product.discount_percent_bps / 100}% для зарегистрированных</span>
           </div>`;
      } else {
        priceRow = product.price > 0
          ? `<div class="shop-price-row"><span class="shop-price">${isService(product) ? 'от ' : ''}${money(product.price)}${unit}</span></div>`
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
    if (category.selectedIndex < 0) category.value = '';
    sort.value = params.get('sort') || 'newest';
    if (sort.selectedIndex < 0) sort.value = 'newest';
  }

  const hasFilters = () => !!(search.value.trim() || category.value || sort.value !== 'newest');

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
      // The unfiltered list is already here — a second request is only needed for filters
      if (hasFilters()) await loadFilteredProducts();
      else render(products);
    } catch {
      grid.innerHTML = '<p class="shop-empty">Не удалось загрузить каталог. Попробуйте обновить страницу.</p>';
    }
  }

  let requestSeq = 0;
  async function loadFilteredProducts() {
    const params = new URLSearchParams({ page_size: '100' });
    if (search.value.trim()) params.set('q', search.value.trim());
    if (category.value) params.set('category', category.value);
    if (sort.value !== 'newest') params.set('sort', sort.value);
    const seq = ++requestSeq;
    grid.innerHTML = '<p class="shop-empty">Загрузка товаров...</p>';
    try {
      const response = await fetch(`/api/products?${params}`);
      if (!response.ok) throw new Error('catalog request failed');
      const items = await response.json();
      if (seq === requestSeq) render(items);   // ignore answers to outdated queries
    } catch {
      if (seq === requestSeq) grid.innerHTML = '<p class="shop-empty">Не удалось загрузить каталог. Попробуйте обновить страницу.</p>';
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
