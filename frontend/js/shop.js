(() => {
  const grid = document.getElementById('shop-grid');
  const search = document.getElementById('shop-search');
  const category = document.getElementById('shop-category');
  const sort = document.getElementById('shop-sort');
  const reset = document.getElementById('shop-reset');
  const resultCount = document.getElementById('shop-result-count');
  let products = [];
  let debounceTimer;

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
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
    grid.innerHTML = items.map(product => `
      <a href="/product/${encodeURIComponent(product.id)}" class="shop-card glass">
        <div class="shop-image" style="background-image:url('/uploads/${encodeURIComponent(product.preview_image || '')}')"></div>
        <div class="shop-info">
          <h3>${escapeHtml(product.title)}</h3>
          ${product.category ? `<span class="shop-category">${escapeHtml(product.category)}</span>` : ''}
          <p class="shop-price">${(product.price / 100).toFixed(2)} ₽</p>
          <p class="shop-stock">${product.stock > 0 ? 'В наличии' : 'Нет в наличии'}</p>
        </div>
      </a>
    `).join('');
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
      [...new Set(products.map(product => product.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru')).forEach(value => {
        category.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`);
      });
      syncFromUrl();
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
    updateUrl();
    loadFilteredProducts();
  });
  loadProducts();
})();
