const pages = {
  overview: ['概览', '今天先处理这些'],
  releases: ['版本发布', '上传安装包并维护发布记录'],
  android: ['Android 管理', '查看 APK 发布与安卓授权设备'],
  activations: ['激活授权', '管理激活码与设备授权'],
  interactions: ['互动统计', '查看账号互动、心情与内容记录'],
  companions: ['搭子联机', '用自己的桌宠给在线设备发来访，并查看配对与投递'],
  analytics: ['增长数据', '官网访问、下载转化与设备留存'],
  content: ['内容库', '维护客户端在线与离线互动资源'],
  'resource-packs': ['资源包', '上传互动词包和小剧场剧本供官网下载'],
  'visit-stickers': ['体验来访', '上传女友、好友、搭子表情，供体验期点一下来串门'],
  feedback: ['问题反馈', '查看问题与建议并更新处理状态']
};

let csrfToken = '';
let toastTimer;

const navItems = document.querySelectorAll('[data-page]');
const pagePanels = document.querySelectorAll('[data-page-panel]');
const quickActions = document.querySelectorAll('[data-go-to]');
const loginView = document.querySelector('#loginView');
const loginForm = document.querySelector('#loginForm');
const loginError = document.querySelector('#loginError');
const adminView = document.querySelector('#adminView');
const logoutButton = document.querySelector('#logoutButton');
const connectionStatus = document.querySelector('#connectionStatus');
const pageTitle = document.querySelector('#pageTitle');
const pageSubtitle = document.querySelector('#pageSubtitle');
const toast = document.querySelector('#toast');
const confirmDialog = document.querySelector('#confirmDialog');
const confirmTitle = document.querySelector('#confirmTitle');
const confirmMessage = document.querySelector('#confirmMessage');
const confirmButton = document.querySelector('#confirmButton');

function navigateTo(pageName) {
  const selectedPage = pages[pageName] ? pageName : 'overview';
  const [title, subtitle] = pages[selectedPage];
  pageTitle.textContent = title;
  pageSubtitle.textContent = subtitle;

  for (const item of navItems) {
    const selected = item.dataset.page === selectedPage;
    if (selected) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }

  for (const panel of pagePanels) {
    panel.hidden = panel.dataset.pagePanel !== selectedPage;
  }

  if (window.location.hash !== `#${selectedPage}`) {
    window.history.replaceState(null, '', `#${selectedPage}`);
  }
  window.scrollTo({ top: 0, behavior: 'auto' });
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
}

function showAdmin(session) {
  csrfToken = session.csrfToken;
  loginView.hidden = true;
  adminView.hidden = false;
  connectionStatus.textContent = '管理服务正常';
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

const pageModules = createAdminPages({
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

for (const item of navItems) {
  item.addEventListener('click', () => navigateTo(item.dataset.page));
}

for (const action of quickActions) {
  action.addEventListener('click', () => navigateTo(action.dataset.goTo));
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
