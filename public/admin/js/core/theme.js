(function () {
  const storageKey = 'deskpet-admin-theme';
  const root = document.documentElement;
  let button;

  function applyTheme(value) {
    const theme = value === 'light' ? 'light' : 'dark';
    root.setAttribute('data-theme', theme);
    if (button) {
      button.textContent = theme === 'dark' ? '浅色' : '暗色';
      button.title = theme === 'dark' ? '切换到浅色主题' : '切换到暗色主题';
    }
    return theme;
  }

  let saved;
  try {
    saved = localStorage.getItem(storageKey);
  } catch {}
  // Run before stylesheets so a saved choice is applied on the first paint.
  applyTheme(saved);

  document.addEventListener('DOMContentLoaded', () => {
    button = document.querySelector('#themeToggleButton');
    applyTheme(root.getAttribute('data-theme'));
    button?.addEventListener('click', () => {
      const next = applyTheme(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
      try {
        localStorage.setItem(storageKey, next);
      } catch {}
    });
  }, { once: true });

  window.addEventListener('storage', (event) => {
    if (event.key === storageKey || event.key === null) applyTheme(event.newValue);
  });
})();
