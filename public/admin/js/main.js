const routeMeta = {
  overview: ['概览', '运营、内容与运维健康度'],
  releases: ['版本发布', '上传安装包并维护发布记录'],
  'android/packages': ['Android · 安装包', '双架构发布状态'],
  'android/devices': ['Android · 设备', '授权设备列表'],
  activations: ['激活授权', '管理激活码与设备授权'],
  'analytics/overview': ['增长数据 · 漏斗', '官网访问与转化概览'],
  'analytics/downloads': ['增长数据 · 下载', '版本包实际下载次数'],
  'analytics/devices': ['增长数据 · 设备', '在线与活跃明细'],
  'analytics/features': ['增长数据 · 功能', '功能事件与接口调用'],
  'analytics/retention': ['增长数据 · 留存', '平台分布与 cohort'],
  interactions: ['互动统计', '账号互动、心情与答题'],
  'companions/overview': ['搭子联机 · 概览', '统计、发送与每日投递'],
  'companions/pairs': ['搭子联机 · 绑定', '当前谁和谁绑定'],
  'companions/profiles': ['搭子联机 · 档案', '联机账号状态'],
  'companions/deliveries': ['搭子联机 · 投递', '最近投递明细'],
  content: ['内容库', '维护六类互动内容'],
  'resource-packs': ['资源包', '上传词包与小剧场'],
  'visit-stickers': ['体验来访', '上传表情包'],
  feedback: ['问题反馈', '问题与建议处理'],
  settings: ['系统设置', '远程配置与默认值']
};

const defaultSubRoute = {
  android: 'packages',
  analytics: 'overview',
  companions: 'overview'
};

const pageModuleIdByRoute = {
  overview: 'overview',
  releases: 'releases',
  android: 'releases',
  activations: 'activations',
  analytics: 'analytics',
  interactions: 'interactions',
  companions: 'companions',
  content: 'content',
  'resource-packs': 'resource-packs',
  'visit-stickers': 'visit-stickers',
  feedback: 'feedback',
  settings: 'settings'
};

let csrfToken = '';
let toastTimer;
let pageModules = [];

const loginView = document.querySelector('#loginView');
const loginForm = document.querySelector('#loginForm');
const loginError = document.querySelector('#loginError');
const adminView = document.querySelector('#adminView');
const logoutButton = document.querySelector('#logoutButton');
const refreshPageButton = document.querySelector('#refreshPageButton');
const themeToggleButton = document.querySelector('#themeToggleButton');
const connectionStatus = document.querySelector('#connectionStatus');
const sidebarToggleButton = document.querySelector('#sidebarToggleButton');
const sidebarCloseButton = document.querySelector('#sidebarCloseButton');
const sidebarBackdrop = document.querySelector('#sidebarBackdrop');
const MOBILE_NAV_QUERY = '(max-width: 900px)';

function isMobileNav() {
  return window.matchMedia(MOBILE_NAV_QUERY).matches;
}

function setMobileNavOpen(open) {
  if (!adminView) return;
  const shouldOpen = Boolean(open) && isMobileNav();
  adminView.classList.toggle('nav-open', shouldOpen);
  document.body.classList.toggle('nav-lock', shouldOpen);
  if (sidebarBackdrop) sidebarBackdrop.hidden = !shouldOpen;
  if (sidebarToggleButton) sidebarToggleButton.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
}

function closeMobileNav() {
  setMobileNavOpen(false);
}

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function syncThemeToggleLabel() {
  if (!themeToggleButton) return;
  const dark = currentTheme() === 'dark';
  themeToggleButton.textContent = dark ? '浅色' : '暗色';
  themeToggleButton.title = dark ? '切换到浅色主题' : '切换到暗色主题';
}

function setTheme(theme) {
  const next = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem('deskpet-admin-theme', next);
  } catch {}
  syncThemeToggleLabel();
}

syncThemeToggleLabel();
const pageTitle = document.querySelector('#pageTitle');
const pageSubtitle = document.querySelector('#pageSubtitle');
const toast = document.querySelector('#toast');
const confirmDialog = document.querySelector('#confirmDialog');
const confirmTitle = document.querySelector('#confirmTitle');
const confirmMessage = document.querySelector('#confirmMessage');
const confirmButton = document.querySelector('#confirmButton');

function parseRoute(raw) {
  const value = String(raw || '').replace(/^#/, '').trim();
  if (!value) return { page: 'overview', sub: null, route: 'overview' };
  const [page, maybeSub] = value.split('/');
  if (defaultSubRoute[page]) {
    const sub = maybeSub && [...document.querySelectorAll(`[data-page-panel="${page}"] [data-subpanel]`)].some((node) => node.dataset.subpanel === maybeSub)
      ? maybeSub
      : defaultSubRoute[page];
    return { page, sub, route: `${page}/${sub}` };
  }
  if (routeMeta[page] || document.querySelector(`[data-page-panel="${page}"]`)) {
    return { page, sub: null, route: page };
  }
  return { page: 'overview', sub: null, route: 'overview' };
}

function setTreeExpanded(parent, expanded) {
  const tree = document.querySelector(`[data-nav-parent="${parent}"]`);
  if (!tree) return;
  const toggle = tree.querySelector('[data-nav-toggle]');
  const children = tree.querySelector('.nav-children');
  if (toggle) toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  if (children) children.hidden = !expanded;
  tree.classList.toggle('is-open', expanded);
}

function navigateTo(rawRoute) {
  // Accept legacy page-only names from old page modules.
  let incoming = String(rawRoute || '');
  if (defaultSubRoute[incoming] && !incoming.includes('/')) {
    incoming = `${incoming}/${defaultSubRoute[incoming]}`;
  }

  const { page, sub, route } = parseRoute(incoming);
  const metaKey = routeMeta[route] ? route : page;
  const [title, subtitle] = routeMeta[metaKey] || routeMeta[page] || ['管理后台', ''];
  pageTitle.textContent = title;
  pageSubtitle.textContent = subtitle;

  for (const panel of document.querySelectorAll('[data-page-panel]')) {
    panel.hidden = panel.dataset.pagePanel !== page;
  }

  const pageRoot = document.querySelector(`[data-page-panel="${page}"]`);
  if (pageRoot) {
    const subpanels = pageRoot.querySelectorAll('[data-subpanel]');
    if (subpanels.length) {
      for (const node of subpanels) {
        node.hidden = node.dataset.subpanel !== sub;
      }
    }
  }

  for (const item of document.querySelectorAll('[data-route]')) {
    const selected = item.dataset.route === route || item.dataset.route === page;
    if (selected) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }

  for (const parent of Object.keys(defaultSubRoute)) {
    const active = page === parent;
    setTreeExpanded(parent, active);
    const toggle = document.querySelector(`[data-nav-toggle="${parent}"]`);
    if (toggle) {
      if (active) toggle.setAttribute('aria-current', 'page');
      else toggle.removeAttribute('aria-current');
    }
  }

  const nextHash = `#${route}`;
  if (window.location.hash !== nextHash) {
    window.history.replaceState(null, '', nextHash);
  }
  window.scrollTo({ top: 0, behavior: 'auto' });
  closeMobileNav();
  return route;
}

function showToast(message, tone = '') {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.toggle('error', tone === 'error');
  toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 3200);
}

function showLogin(message = '') {
  csrfToken = '';
  loginError.textContent = message;
  loginView.hidden = false;
  adminView.hidden = true;
  closeMobileNav();
}

function showAdmin(session) {
  csrfToken = session.csrfToken;
  loginView.hidden = true;
  adminView.hidden = false;
  connectionStatus.textContent = '管理服务正常';
  closeMobileNav();
  navigateTo(window.location.hash.slice(1));
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && typeof options.body !== 'string' && !(options.body instanceof Blob)) {
    headers.set('Content-Type', 'application/json');
    options.body = JSON.stringify(options.body);
  }
  if (options.method && options.method !== 'GET' && csrfToken) headers.set('X-CSRF-Token', csrfToken);
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) showLogin('登录已失效，请重新登录');
    const error = new Error(payload.error || `请求失败 (${response.status})`);
    error.status = response.status;
    error.code = payload.code;
    throw error;
  }
  return payload;
}

const ui = createAdminUI({
  api,
  showToast,
  showLogin,
  getCsrfToken: () => csrfToken
});

function confirmAction({ title, message, confirmLabel = '确认', danger = false }) {
  confirmTitle.textContent = title;
  confirmMessage.textContent = message;
  confirmButton.textContent = confirmLabel;
  confirmButton.className = `button ${danger ? 'button-danger' : 'button-primary'}`;
  confirmDialog.showModal();
  return new Promise((resolve) => {
    confirmDialog.addEventListener('close', () => {
      resolve(confirmDialog.returnValue === 'confirm');
    }, { once: true });
  });
}

pageModules = createAdminPages({
  ui,
  api,
  showToast,
  showLogin,
  confirmAction,
  navigateTo
});

async function loadDashboard() {
  await Promise.all(pageModules.map((page) => page.load?.()));
}

async function refreshCurrentPage() {
  const { page, route } = parseRoute(window.location.hash.slice(1));
  navigateTo(route);
  const moduleId = pageModuleIdByRoute[page] || page;
  const target = pageModules.find((item) => item.id === moduleId);
  if (target?.load) await target.load();
  else await loadDashboard();
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginError.textContent = '';
  const submit = loginForm.querySelector('button[type="submit"]');
  const data = new FormData(loginForm);
  await ui.withBusy(submit, async () => {
    const session = await api('/api/admin/login', {
      method: 'POST',
      body: { username: data.get('username'), password: data.get('password') }
    });
    loginForm.reset();
    loginForm.elements.username.value = 'admin';
    showAdmin(session);
    await loadDashboard();
  }, (error) => {
    loginError.textContent = error.message;
  });
});

logoutButton.addEventListener('click', async () => {
  try {
    await api('/api/admin/logout', { method: 'POST' });
  } catch {}
  showLogin();
});

refreshPageButton?.addEventListener('click', async () => {
  await ui.withBusy(refreshPageButton, refreshCurrentPage);
});

themeToggleButton?.addEventListener('click', () => {
  setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
});

sidebarToggleButton?.addEventListener('click', () => {
  setMobileNavOpen(!adminView.classList.contains('nav-open'));
});

sidebarCloseButton?.addEventListener('click', closeMobileNav);
sidebarBackdrop?.addEventListener('click', closeMobileNav);

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMobileNav();
});

window.matchMedia(MOBILE_NAV_QUERY).addEventListener('change', (event) => {
  if (!event.matches) closeMobileNav();
});

for (const item of document.querySelectorAll('[data-route]')) {
  item.addEventListener('click', () => navigateTo(item.dataset.route));
}

for (const toggle of document.querySelectorAll('[data-nav-toggle]')) {
  toggle.addEventListener('click', () => {
    const parent = toggle.dataset.navToggle;
    const tree = document.querySelector(`[data-nav-parent="${parent}"]`);
    const open = tree?.classList.contains('is-open');
    if (open) {
      setTreeExpanded(parent, false);
      return;
    }
    // Jump to default child when expanding from collapsed state.
    navigateTo(`${parent}/${defaultSubRoute[parent]}`);
  });
}

window.addEventListener('hashchange', () => {
  if (!adminView.hidden) navigateTo(window.location.hash.slice(1));
});

async function initialize() {
  try {
    const session = await api('/api/admin/session');
    if (!session.authenticated) return showLogin();
    showAdmin(session);
    await loadDashboard();
  } catch (error) {
    showLogin(error.message);
  }
}

initialize();
