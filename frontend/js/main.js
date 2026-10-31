(function() {
  'use strict';

  // --- Автозаполнение контактных полей: профиль, иначе прошлый ввод в этом браузере
  const CONTACT_STORE = 'groutpro-contact';

  function plural(n, one, few, many) {
    const mod10 = n % 10, mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
    return many;
  }

  function rememberContact(values) {
    try { localStorage.setItem(CONTACT_STORE, JSON.stringify(values)); } catch (e) {}
  }

  let profilePromise = null;
  function loadProfile() {
    if (!profilePromise) {
      profilePromise = fetch('/api/auth/me', { credentials: 'same-origin' })
        .then(r => (r.ok ? r.json() : null))
        .catch(() => null);
    }
    return profilePromise;
  }

  async function fillContactFields(ids) {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(CONTACT_STORE) || '{}'); } catch (e) {}
    const profile = await loadProfile();
    const values = {
      name: profile?.display_name || saved.name || '',
      phone: profile?.phone || saved.phone || '',
      email: profile?.email || saved.email || ''
    };
    Object.entries(ids).forEach(([key, id]) => {
      const el = document.getElementById(id);
      if (el && !el.value && values[key]) el.value = values[key];
    });
  }


  // Учёт посещений: один просмотр на загрузку страницы, без ожидания ответа и без ошибок.
  // Страница товара отправляет просмотр с категорией товара (product.js свой больше не шлёт).
  const sendView = category => {
    try {
      fetch('/api/analytics/view', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(category ? { path: location.pathname, category } : { path: location.pathname }),
        keepalive: true
      }).catch(() => {});
    } catch (e) {}
  };
  if (document.getElementById('prod-title')) {
    const productId = new URLSearchParams(location.search).get('id')
      || (location.pathname.match(/^\/product\/([0-9a-fA-F-]{36})\/?$/) || [])[1];
    // Без id product.js сразу уводит в каталог — там просмотр и засчитается
    if (productId) {
      fetch('/api/products/' + encodeURIComponent(productId))
        .then(r => (r.ok ? r.json() : null))
        .catch(() => null)
        .then(p => sendView(p && p.category));
    }
  } else {
    sendView(null);
  }

  // Theme toggle
  const themeToggle = document.getElementById('themeToggle');
  const html = document.documentElement;
  const iconSun = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';
  const iconMoon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

  // localStorage can be unavailable (private mode, blocked site data): theme must still work
  function readStoredTheme() {
    try { return localStorage.getItem('groutpro-theme'); } catch (e) { return null; }
  }

  function setTheme(theme, persist) {
    html.setAttribute('data-theme', theme);
    if (persist) {
      try { localStorage.setItem('groutpro-theme', theme); } catch (e) {}
    }
    if (themeToggle) themeToggle.innerHTML = theme === 'dark' ? iconSun : iconMoon;
  }

  const darkSchemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
  setTheme(readStoredTheme() || (darkSchemeQuery.matches ? 'dark' : 'light'), false);

  // Until the visitor picks a theme explicitly, follow the OS setting
  const onSchemeChange = (e) => { if (!readStoredTheme()) setTheme(e.matches ? 'dark' : 'light', false); };
  if (darkSchemeQuery.addEventListener) darkSchemeQuery.addEventListener('change', onSchemeChange);

  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const current = html.getAttribute('data-theme');
      setTheme(current === 'dark' ? 'light' : 'dark', true);
    });
  }

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  // Scroll lock shared by the mobile menu and the lightbox
  const scrollLocks = new Set();
  function lockScroll(reason, on) {
    if (on) scrollLocks.add(reason); else scrollLocks.delete(reason);
    html.classList.toggle('is-scroll-locked', scrollLocks.size > 0);
  }

  // Navbar scroll effect
  const nav = document.querySelector('.nav');
  if (nav) {
    const syncNav = () => nav.classList.toggle('scrolled', window.pageYOffset > 50);
    window.addEventListener('scroll', syncNav, { passive: true });
    syncNav();
  }

  // Reveal on scroll
  const revealElements = document.querySelectorAll('.reveal');
  const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('active');
        revealObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });

  revealElements.forEach(el => revealObserver.observe(el));

  // Landing directly on a hash (e.g. /#contact from another page's nav link)
  // jumps straight past most .reveal sections, so they never intersect and
  // stay permanently hidden. Skip the scroll-triggered animation in that case.
  if (location.hash) {
    revealElements.forEach(el => el.classList.add('active'));
  }

  // Mobile menu: #menuBtn is a <button aria-controls="mobileMenu">; the closed menu is
  // visibility:hidden + inert, so its links are neither visible nor focusable.
  const menuBtn = document.getElementById('menuBtn');
  const mobileMenu = document.getElementById('mobileMenu');

  if (menuBtn && mobileMenu) {
    const isMenuOpen = () => mobileMenu.classList.contains('active');
    // While the menu covers the page, Tab must not wander into the hidden page behind it
    const inertedByMenu = new Set();
    const setPageInert = on => {
      if (on) {
        Array.from(document.body.children).forEach(el => {
          if (el === mobileMenu || el.contains(menuBtn) || el.tagName === 'SCRIPT' || el.hasAttribute('inert')) return;
          el.setAttribute('inert', '');
          inertedByMenu.add(el);
        });
      } else {
        inertedByMenu.forEach(el => el.removeAttribute('inert'));
        inertedByMenu.clear();
      }
    };

    const setMenu = (open, restoreFocus) => {
      mobileMenu.classList.toggle('active', open);
      mobileMenu.toggleAttribute('inert', !open);
      setPageInert(open);
      menuBtn.classList.toggle('active', open);
      menuBtn.setAttribute('aria-expanded', String(open));
      menuBtn.setAttribute('aria-label', open ? 'Закрыть меню' : 'Открыть меню');
      html.classList.toggle('is-menu-open', open);
      lockScroll('menu', open);
      if (!open && restoreFocus) menuBtn.focus();
    };

    menuBtn.addEventListener('click', () => setMenu(!isMenuOpen(), false));
    // Any link (incl. the call button) closes the menu before the browser follows it
    mobileMenu.addEventListener('click', (e) => { if (e.target.closest('a')) setMenu(false, false); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isMenuOpen()) setMenu(false, true);
    });
    // Widening past the burger breakpoint must not leave the page locked behind a hidden menu
    const desktopNav = window.matchMedia('(min-width: 1101px)');
    const onDesktopNav = (e) => { if (e.matches && isMenuOpen()) setMenu(false, false); };
    if (desktopNav.addEventListener) desktopNav.addEventListener('change', onDesktopNav);
  }

  // Stats counter animation
  const statNumbers = document.querySelectorAll('.stat-number[data-count]');
  const statsObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const el = entry.target;
        const target = parseInt(el.getAttribute('data-count'));
        const suffix = el.getAttribute('data-suffix') || '';
        const duration = 2000;
        const start = performance.now();

        function update(now) {
          const elapsed = now - start;
          const progress = Math.min(elapsed / duration, 1);
          const eased = 1 - Math.pow(1 - progress, 3);
          const current = Math.floor(eased * target);
          el.textContent = current + suffix;
          if (progress < 1) requestAnimationFrame(update);
        }
        requestAnimationFrame(update);
        statsObserver.unobserve(el);
      }
    });
  }, { threshold: 0.5 });

  statNumbers.forEach(el => statsObserver.observe(el));

  // In-page links (#contact, or /#contact while already on the home page): smooth scroll that
  // honours scroll-margin-top and prefers-reduced-motion and keeps the hash in the address bar.
  const findHashTarget = (hash) => {
    if (!hash || hash.length < 2) return null;
    try { return document.getElementById(decodeURIComponent(hash.slice(1))); } catch (e) { return null; }
  };

  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const link = e.target.closest('a[href]');
    if (!link || (link.target && link.target !== '_self') || link.hasAttribute('download')) return;
    const href = link.getAttribute('href');
    if (/^(tel|mailto):/i.test(href)) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || url.pathname !== location.pathname || url.search !== location.search) return;
    const behavior = reduceMotion.matches ? 'auto' : 'smooth';
    if (!url.hash) {
      if (href.charAt(0) === '#') return;
      // e.g. «Главная» on the home page: back to the top instead of reloading
      e.preventDefault();
      window.scrollTo({ top: 0, behavior });
      if (location.hash) history.pushState(null, '', url.pathname + url.search);
      return;
    }
    const target = findHashTarget(url.hash);
    if (!target) return;
    e.preventDefault();
    target.scrollIntoView({ behavior, block: 'start' });
    if (location.hash !== url.hash) history.pushState(null, '', url.hash);
  });

  // Arriving from another page at /#contact etc.: the price list and the reviews are rendered
  // above the target after the browser has already jumped to it, pushing it down. Re-align once
  // when they (and the web font) are in, unless the visitor has started scrolling meanwhile.
  const landingTarget = findHashTarget(location.hash);
  if (landingTarget) {
    const blocksAbove = ['estimate-items', 'reviews-list']
      .map(id => document.getElementById(id))
      .filter(el => el && (el.compareDocumentPosition(landingTarget) & Node.DOCUMENT_POSITION_FOLLOWING));
    if (blocksAbove.length) {
      let userScrolled = false;
      const interactions = ['wheel', 'touchstart', 'keydown', 'mousedown'];
      const onInteract = () => { userScrolled = true; };
      interactions.forEach(type => window.addEventListener(type, onInteract, { passive: true }));
      const firstRender = el => new Promise(resolve => {
        const observer = new MutationObserver(() => { observer.disconnect(); resolve(); });
        observer.observe(el, { childList: true });
        setTimeout(() => { observer.disconnect(); resolve(); }, 6000);
      });
      const waits = blocksAbove.map(firstRender);
      if (document.fonts && document.fonts.ready) waits.push(document.fonts.ready.catch(() => {}));
      Promise.all(waits).then(() => {
        interactions.forEach(type => window.removeEventListener(type, onInteract));
        if (userScrolled) return;
        requestAnimationFrame(() => {
          const previous = html.style.scrollBehavior;
          html.style.scrollBehavior = 'auto';
          landingTarget.scrollIntoView({ block: 'start' });
          html.style.scrollBehavior = previous;
        });
      });
    }
  }

  // Hero parallax: desktop with a precise pointer only (costly on phones), never with reduced motion
  const heroBg = document.querySelector('.hero-bg');
  if (heroBg) {
    const parallaxQuery = window.matchMedia('(min-width: 901px) and (hover: hover) and (pointer: fine)');
    let parallaxQueued = false;
    const applyParallax = () => {
      parallaxQueued = false;
      const y = window.pageYOffset;
      const on = parallaxQuery.matches && !reduceMotion.matches && y < window.innerHeight * 1.5;
      heroBg.style.transform = on ? `translateY(${y * 0.3}px)` : '';
    };
    window.addEventListener('scroll', () => {
      if (!parallaxQueued) { parallaxQueued = true; requestAnimationFrame(applyParallax); }
    }, { passive: true });
  }

  const CONTACT_LOCATION = {
    phone: '+7 905 405-31-33',
    phoneHref: '+79054053133',
    email: 'info@groutpro.ru',
    address: 'Краснодар, ул. Новороссийская, 51/2',
    coordinates: '',
    yandexMapsUrl: 'https://yandex.ru/maps/?text=%D0%9A%D1%80%D0%B0%D1%81%D0%BD%D0%BE%D0%B4%D0%B0%D1%80%2C%20%D1%83%D0%BB%D0%B8%D1%86%D0%B0%20%D0%9D%D0%BE%D0%B2%D0%BE%D1%80%D0%BE%D1%81%D1%81%D0%B8%D0%B9%D1%81%D0%BA%D0%B0%D1%8F%2C%2051%2F2'
  };

  const phoneLink = document.getElementById('contact-phone-link');
  const emailLink = document.getElementById('contact-email-link');
  if (phoneLink) {
    phoneLink.textContent = CONTACT_LOCATION.phone;
    phoneLink.href = `tel:${CONTACT_LOCATION.phoneHref}`;
  }
  if (emailLink) {
    emailLink.textContent = CONTACT_LOCATION.email;
    emailLink.href = `mailto:${CONTACT_LOCATION.email}`;
  }

  const addressLink = document.getElementById('contact-address-link');
  const mapLink = document.getElementById('contact-map-link');
  const regionToggle = document.getElementById('region-toggle');
  const regionMap = document.getElementById('region-map');

  if (addressLink && mapLink) {
    addressLink.textContent = CONTACT_LOCATION.address;
    addressLink.href = CONTACT_LOCATION.yandexMapsUrl;
    mapLink.href = CONTACT_LOCATION.yandexMapsUrl;
  }

  if (regionToggle && regionMap) {
    regionToggle.addEventListener('click', () => {
      const isExpanded = regionToggle.getAttribute('aria-expanded') === 'true';
      regionToggle.setAttribute('aria-expanded', String(!isExpanded));
      regionMap.classList.toggle('is-open', !isExpanded);
    });
  }

  // Gallery lightbox. Photos and captions come from the gallery markup itself, so the order
  // and texts can never drift apart. Items are keyboard-operable buttons; focus is kept inside
  // the dialog while it is open and returns to the photo that opened it.
  const lightbox = document.getElementById('lightbox');
  const galleryItems = [...document.querySelectorAll('.gallery-item')].filter(item => item.querySelector('img'));
  if (lightbox && galleryItems.length) {
    const lbImage = document.getElementById('lightbox-image');
    const lbCaption = document.getElementById('lightbox-caption');
    const lbCounter = document.getElementById('lightbox-counter');
    const lbClose = document.getElementById('lightbox-close');
    const lbPrev = document.getElementById('lightbox-prev');
    const lbNext = document.getElementById('lightbox-next');
    const photos = galleryItems.map(item => {
      const img = item.querySelector('img');
      return { src: img.getAttribute('src'), caption: img.getAttribute('alt') || '' };
    });
    let currentIndex = 0;
    let returnFocus = null;
    let hideTimer = null;
    const isLightboxOpen = () => lightbox.classList.contains('is-open');

    function renderSlide() {
      const photo = photos[currentIndex];
      lbImage.style.opacity = '0';
      setTimeout(() => {
        lbImage.src = photo.src;
        lbImage.alt = photo.caption;
        lbImage.style.opacity = '1';
      }, 120);
      lbCaption.textContent = photo.caption;
      lbCounter.textContent = `${currentIndex + 1} / ${photos.length}`;
    }

    function openLightbox(index) {
      currentIndex = index;
      returnFocus = document.activeElement;
      clearTimeout(hideTimer);
      lightbox.hidden = false;
      lockScroll('lightbox', true);
      requestAnimationFrame(() => lightbox.classList.add('is-open'));
      renderSlide();
      lbClose.focus({ preventScroll: true });
    }

    function closeLightbox() {
      if (lightbox.hidden) return;
      lightbox.classList.remove('is-open');
      lockScroll('lightbox', false);
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { lightbox.hidden = true; }, 250);
      if (returnFocus && typeof returnFocus.focus === 'function') returnFocus.focus({ preventScroll: true });
      returnFocus = null;
    }

    function step(delta) {
      currentIndex = (currentIndex + delta + photos.length) % photos.length;
      renderSlide();
    }

    galleryItems.forEach((item, index) => {
      item.setAttribute('role', 'button');
      item.setAttribute('tabindex', '0');
      item.setAttribute('aria-label', `Открыть фото: ${photos[index].caption}`);
      item.addEventListener('click', () => openLightbox(index));
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openLightbox(index);
        }
      });
    });

    lbClose.addEventListener('click', closeLightbox);
    lbPrev.addEventListener('click', () => step(-1));
    lbNext.addEventListener('click', () => step(1));
    lightbox.addEventListener('click', (e) => { if (e.target === lightbox) closeLightbox(); });

    // Swipe left/right on touch screens
    let touchStartX = null;
    lightbox.addEventListener('touchstart', (e) => {
      touchStartX = e.touches.length === 1 ? e.touches[0].clientX : null;
    }, { passive: true });
    lightbox.addEventListener('touchend', (e) => {
      if (touchStartX === null) return;
      const dx = e.changedTouches[0].clientX - touchStartX;
      touchStartX = null;
      if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
    });

    document.addEventListener('keydown', (e) => {
      if (lightbox.hidden || !isLightboxOpen()) return;
      if (e.key === 'Escape') { e.preventDefault(); closeLightbox(); }
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'Tab') {
        const focusable = [lbClose, lbPrev, lbNext];
        const i = focusable.indexOf(document.activeElement);
        e.preventDefault();
        focusable[e.shiftKey ? (i <= 0 ? focusable.length - 1 : i - 1) : (i + 1) % focusable.length].focus();
      }
    });
  }

  // Contact form → /api/contact (stored + forwarded to Telegram/MAX/email)
  const contactForm = document.getElementById('contact-form');
  if (contactForm) {
    fillContactFields({ name: 'contact-name', phone: 'contact-phone', email: 'contact-email' });
    const status = document.getElementById('contact-form-status');
    const field = id => document.getElementById(id);
    const setStatus = (text, kind) => {
      status.textContent = text;
      status.classList.toggle('is-error', kind === 'error');
      status.classList.toggle('is-success', kind === 'success');
    };

    contactForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = field('contact-name').value.trim();
      const phone = field('contact-phone').value.trim();
      const email = field('contact-email').value.trim();
      if (name.length < 2) { setStatus('Укажите, как к вам обращаться', 'error'); field('contact-name').focus(); return; }
      if (phone.replace(/\D/g, '').length < 10) { setStatus('Проверьте номер телефона', 'error'); field('contact-phone').focus(); return; }
      if (email && !field('contact-email').checkValidity()) { setStatus('Проверьте email', 'error'); field('contact-email').focus(); return; }

      const btn = contactForm.querySelector('button[type="submit"]');
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Отправляем...';
      setStatus('', null);
      try {
        const res = await fetch('/api/contact', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            phone,
            email: email || null,
            message: field('contact-message').value.trim() || null,
            consent: true,
            website: field('contact-website').value
          })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Не удалось отправить заявку');
        rememberContact({ name, phone, email });
        contactForm.reset();
        setStatus('Спасибо! Заявка отправлена — мы свяжемся с вами в ближайшее время.', 'success');
      } catch (err) {
        setStatus(err.message === 'Failed to fetch' ? 'Нет соединения с сервером, попробуйте ещё раз' : err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });
  }

  const rub = value => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(value / 100);
  const escapeText = text => { const d = document.createElement('div'); d.textContent = text; return d.innerHTML; };

  // --- Ориентировочная смета по действующему прайсу магазина
  const estimateBox = document.getElementById('estimate-items');
  if (estimateBox) {
    let priceList = [];

    const recalc = () => {
      let total = 0;
      let quote = false; // выбрана хотя бы одна позиция «по запросу»
      priceList.forEach((item, i) => {
        const row = document.getElementById('estimate-row-' + i);
        if (!row) return;
        const on = row.querySelector('input[type="checkbox"]').checked;
        const sum = item.price;
        row.classList.toggle('is-on', on);
        const sumEl = row.querySelector('.estimate-item-sum');
        if (sumEl) sumEl.textContent = on ? (sum > 0 ? rub(sum) : 'по запросу') : '';
        if (on && sum > 0) total += sum;
        if (on && !(sum > 0)) quote = true;
      });
      // Только позиции «по запросу» — показываем «по запросу», а не «0 ₽»
      const quoteOnly = total === 0 && quote;
      const totalText = quoteOnly ? 'по запросу' : rub(total);
      document.getElementById('estimate-works').textContent = totalText;
      document.getElementById('estimate-total').textContent = totalText;
      const totalLabel = document.querySelector('.estimate-row--total span');
      if (totalLabel) totalLabel.textContent = quoteOnly ? 'Стоимость' : 'Ориентировочно от';
      estimateBox.dataset.total = String(total);
    };

    fetch('/api/products?page_size=50')
      .then(r => r.json())
      .then(products => {
        // Цена 0 — «по запросу»: позицию показываем, но в сумму она не входит
        priceList = (products || []).filter(p => p.price >= 0);
        if (!priceList.length) {
          estimateBox.innerHTML = '<p style="color:var(--muted)">Прайс появится, когда в магазине будут позиции.</p>';
          return;
        }
        estimateBox.innerHTML = priceList.map((p, i) =>
          '<label class="estimate-item" id="estimate-row-' + i + '">' +
            '<input type="checkbox" aria-label="Включить в смету: ' + escapeText(p.title) + '">' +
            '<span class="estimate-item-title">' + escapeText(p.title) +
              '<small>' + escapeText(p.category || 'услуга') + ' &middot; ' + (p.price > 0 ? (p.unit && p.unit !== 'шт' ? 'от ' : '') + rub(p.price) + (p.unit ? ' / ' + escapeText(p.unit) : '') : 'цена по запросу') + '</small>' +
            '</span>' +
            '<span class="estimate-item-sum"></span>' +
          '</label>'
        ).join('');
        estimateBox.addEventListener('input', recalc);
        recalc();
      })
      .catch(() => {
        estimateBox.innerHTML = '<p style="color:var(--muted)">Не удалось загрузить прайс. Позвоните нам — посчитаем вручную.</p>';
      });

    const chosenItems = () => priceList
      .map((item, i) => ({ item, row: document.getElementById('estimate-row-' + i) }))
      .filter(entry => entry.row && entry.row.querySelector('input[type="checkbox"]').checked)
      .map(entry => ({ product_id: entry.item.id, quantity: 1, title: entry.item.title }));

    const estimateForm = document.getElementById('estimate-form');
    const estimateStatus = document.getElementById('estimate-status');
    const openBtn = document.getElementById('estimate-request');

    openBtn.addEventListener('click', async () => {
      const chosen = chosenItems();
      estimateStatus.textContent = '';
      estimateStatus.classList.remove('is-error', 'is-success');
      // Работы человека может не быть в списке — форму всё равно открываем
      document.getElementById('estimate-chosen').textContent = chosen.length
        ? `· ${chosen.length} ${plural(chosen.length, 'позиция', 'позиции', 'позиций')}, ${Number(estimateBox.dataset.total) > 0 ? 'ориентировочно от ' + rub(Number(estimateBox.dataset.total)) : 'стоимость по запросу'}`
        : '· опишите задачу, подберём работы и посчитаем сами';
      estimateForm.hidden = false;
      await fillContactFields({
        name: 'estimate-name', phone: 'estimate-phone', email: 'estimate-email'
      });
      const firstEmpty = ['estimate-name', 'estimate-phone', 'estimate-comment']
        .map(id => document.getElementById(id))
        .find(el => el && !el.value);
      (firstEmpty || document.getElementById('estimate-comment')).focus();
      estimateForm.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    estimateForm.addEventListener('submit', async event => {
      event.preventDefault();
      const chosen = chosenItems();
      const name = document.getElementById('estimate-name').value.trim();
      const phone = document.getElementById('estimate-phone').value.trim();
      const email = document.getElementById('estimate-email').value.trim();
      if (phone.replace(/\D/g, '').length < 10) {
        estimateStatus.textContent = 'Проверьте номер телефона';
        estimateStatus.classList.add('is-error');
        document.getElementById('estimate-phone').focus();
        return;
      }
      const btn = estimateForm.querySelector('button[type="submit"]');
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Отправляем...';
      estimateStatus.textContent = '';
      estimateStatus.classList.remove('is-error', 'is-success');
      try {
        const res = await fetch('/api/contact', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            phone,
            email: email || null,
            message: document.getElementById('estimate-comment').value.trim()
              || (chosen.length ? 'Запрос замера по смете с сайта' : 'Запрос замера: работы в списке нет, нужен подбор'),
            consent: document.getElementById('estimate-consent').checked,
            website: document.getElementById('estimate-website').value,
            estimate: chosen.map(({ product_id, quantity }) => ({ product_id, quantity }))
          })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Не удалось отправить заявку');
        rememberContact({ name, phone, email });
        estimateForm.reset();
        estimateForm.hidden = true;
        estimateStatus.textContent = 'Заявка на замер принята. Перезвоним и согласуем время выезда.';
        estimateStatus.classList.add('is-success');
      } catch (err) {
        estimateStatus.textContent = err.message === 'Failed to fetch' ? 'Нет соединения с сервером, попробуйте ещё раз' : err.message;
        estimateStatus.classList.add('is-error');
      } finally {
        btn.disabled = false;
        btn.textContent = label;
      }
    });
  }

  // --- Отзывы и предложения
  const reviewsList = document.getElementById('reviews-list');
  if (reviewsList) {
    const stars = n => '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);

    fetch('/api/reviews')
      .then(r => r.json())
      .then(items => {
        reviewsList.innerHTML = (items && items.length)
          ? items.map(r =>
              '<article class="review-card glass">' +
                (r.rating ? '<div class="review-stars" aria-label="Оценка ' + r.rating + ' из 5">' + stars(r.rating) + '</div>' : '') +
                '<p class="review-text">' + escapeText(r.message) + '</p>' +
                '<p class="review-author">' + escapeText(r.author_name) + ' &middot; ' + new Date(r.created_at).toLocaleDateString('ru-RU') + '</p>' +
              '</article>').join('')
          : '<p class="reviews-empty">Отзывов пока нет — будьте первым, кто расскажет о работе.</p>';
      })
      .catch(() => { reviewsList.innerHTML = ''; });

    let rating = 5;
    const ratingBox = document.getElementById('review-rating');
    const paintStars = () => ratingBox.querySelectorAll('.review-star').forEach(b => {
      const value = Number(b.dataset.value);
      b.classList.toggle('is-on', value <= rating);
      b.setAttribute('aria-pressed', String(value === rating));
    });
    ratingBox.addEventListener('click', event => {
      const star = event.target.closest('.review-star');
      if (!star) return;
      rating = Number(star.dataset.value);
      paintStars();
    });
    paintStars();

    // The rating only applies to reviews; form.reset() fires no change event, so resync after it too
    const ratingGroup = document.getElementById('review-rating-group');
    const syncRatingGroup = () => {
      const kind = document.querySelector('input[name="review-kind"]:checked');
      ratingGroup.hidden = !!kind && kind.value === 'suggestion';
    };
    document.querySelectorAll('input[name="review-kind"]').forEach(input => input.addEventListener('change', syncRatingGroup));
    syncRatingGroup();

    const status = document.getElementById('review-status');
    document.getElementById('review-form').addEventListener('submit', async event => {
      event.preventDefault();
      const kind = document.querySelector('input[name="review-kind"]:checked').value;
      const btn = event.target.querySelector('button[type="submit"]');
      btn.disabled = true;
      status.textContent = '';
      status.classList.remove('is-error', 'is-success');
      try {
        const res = await fetch('/api/reviews', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind,
            author_name: document.getElementById('review-name').value.trim(),
            rating: kind === 'review' ? rating : null,
            message: document.getElementById('review-message').value.trim(),
            contact: document.getElementById('review-contact').value.trim() || null,
            consent: document.getElementById('review-consent').checked,
            website: document.getElementById('review-website').value
          })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Не удалось отправить');
        event.target.reset();
        rating = 5;
        paintStars();
        syncRatingGroup();
        status.textContent = kind === 'suggestion'
          ? 'Спасибо! Передали предложение — посмотрим и ответим, если оставили контакт.'
          : 'Спасибо! Отзыв появится на сайте после проверки.';
        status.classList.add('is-success');
      } catch (err) {
        status.textContent = err.message === 'Failed to fetch' ? 'Нет соединения с сервером' : err.message;
        status.classList.add('is-error');
      } finally {
        btn.disabled = false;
      }
    });
  }

})();

// ============================================================================
// Аналитика направлений на главной + цвет панели браузера.
// Самостоятельные блоки: не используют код выше, сетевые ошибки глушатся.
// ============================================================================

// --- Какие направления смотрят: «Инъектирование бетона», «Гидроизоляция»,
// «Стабилизация грунта». Заголовок карточки в index.html помечен data-topic.
// Когда карточка видна хотя бы наполовину не меньше секунды, отправляем
// просмотр с этой категорией — по одному разу на направление за загрузку.
// Путь вида «/#services» (раздел, где увидели) отличает такие события от
// просмотров страниц: у настоящих страниц в пути нет «#».
(function () {
  'use strict';
  const markers = document.querySelectorAll('[data-topic]');
  if (!markers.length || !('IntersectionObserver' in window)) return;

  const MIN_VISIBLE_MS = 1000;
  const topicOf = new Map();   // карточка → направление
  const timers = new Map();    // карточка → таймер «видна достаточно долго»
  const sent = new Set();      // направления, уже отправленные с этой загрузки

  const report = (topic, card) => {
    const section = card.closest('section[id]');
    try {
      fetch('/api/analytics/view', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: location.pathname + '#' + (section ? section.id : 'topic'), category: topic }),
        keepalive: true
      }).catch(() => {});
    } catch (e) {}
  };

  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      const card = entry.target;
      const topic = topicOf.get(card);
      if (!entry.isIntersecting) {
        clearTimeout(timers.get(card));
        timers.delete(card);
        return;
      }
      if (sent.has(topic) || timers.has(card)) return;
      timers.set(card, setTimeout(() => {
        timers.delete(card);
        if (sent.has(topic)) return;
        sent.add(topic);
        report(topic, card);
        topicOf.forEach((t, el) => { if (t === topic) observer.unobserve(el); });
      }, MIN_VISIBLE_MS));
    });
  }, { threshold: 0.5 });

  markers.forEach(marker => {
    const topic = marker.dataset.topic.trim();
    const card = marker.closest('.card') || marker;
    if (!topic || topicOf.has(card)) return;
    topicOf.set(card, topic);
    observer.observe(card);
  });
})();

// --- <meta name="theme-color"> следует за темой сайта (переключатель в шапке),
// а не только за системной: цвет берём из --bg текущей темы.
(function () {
  'use strict';
  const metas = document.querySelectorAll('meta[name="theme-color"]');
  if (!metas.length) return;
  const root = document.documentElement;
  const apply = () => {
    const color = getComputedStyle(root).getPropertyValue('--bg').trim();
    if (color) metas.forEach(meta => meta.setAttribute('content', color));
  };
  apply();
  new MutationObserver(apply).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
})();
