(function () {
  'use strict';
  const html = document.documentElement;
  const themeToggle = document.getElementById('themeToggle');
  const nav = document.querySelector('.nav');
  const mobileMenu = document.getElementById('mobileMenu');
  const menuBtn = document.getElementById('menuBtn');
  const menuClose = document.getElementById('menuClose');
  const iconSun = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';
  const iconMoon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  function setTheme(theme) { html.dataset.theme = theme; try { localStorage.setItem('groutpro-theme', theme); } catch (_) {} if (themeToggle) themeToggle.innerHTML = theme === 'dark' ? iconSun : iconMoon; }
  let savedTheme = null; try { savedTheme = localStorage.getItem('groutpro-theme'); } catch (_) {}
  setTheme(savedTheme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  if (themeToggle) themeToggle.addEventListener('click', () => setTheme(html.dataset.theme === 'dark' ? 'light' : 'dark'));
  if (nav) window.addEventListener('scroll', () => nav.classList.toggle('scrolled', window.scrollY > 50), { passive: true });
  const revealElements = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) { const observer = new IntersectionObserver(entries => entries.forEach(entry => { if (entry.isIntersecting) { entry.target.classList.add('active'); observer.unobserve(entry.target); } }), { threshold: 0.1, rootMargin: '0px 0px -50px 0px' }); revealElements.forEach(el => observer.observe(el)); } else revealElements.forEach(el => el.classList.add('active'));
  function toggleMenu(show) { if (!mobileMenu) return; mobileMenu.classList.toggle('active', show); document.body.style.overflow = show ? 'hidden' : ''; }
  if (menuBtn) menuBtn.addEventListener('click', () => toggleMenu(true));
  if (menuClose) menuClose.addEventListener('click', () => toggleMenu(false));
  if (mobileMenu) mobileMenu.querySelectorAll('a').forEach(link => link.addEventListener('click', () => toggleMenu(false)));
  document.querySelectorAll('a[href^="#"]').forEach(anchor => anchor.addEventListener('click', event => { const selector = anchor.getAttribute('href'); if (!selector || selector === '#') return; const target = document.querySelector(selector); if (target) { event.preventDefault(); target.scrollIntoView({ behavior: 'smooth', block: 'start' }); history.replaceState(null, '', selector); } }));
  document.querySelectorAll('.stat-number[data-count]').forEach(el => { const target = Number(el.dataset.count); const suffix = el.dataset.suffix || ''; if (!('IntersectionObserver' in window)) { el.textContent = target + suffix; return; } const observer = new IntersectionObserver(entries => entries.forEach(entry => { if (!entry.isIntersecting) return; el.textContent = target + suffix; observer.disconnect(); }), { threshold: .5 }); observer.observe(el); });
  const heroBg = document.querySelector('.hero-bg');
  if (heroBg && !window.matchMedia('(pointer: coarse)').matches && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) window.addEventListener('scroll', () => { heroBg.style.transform = `translateY(${window.scrollY * .3}px)`; }, { passive: true });
})();
