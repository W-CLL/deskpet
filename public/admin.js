const elements = {
  loginView: document.querySelector('#loginView'),
  loginForm: document.querySelector('#loginForm'),
  loginError: document.querySelector('#loginError'),
  adminView: document.querySelector('#adminView'),
  logoutButton: document.querySelector('#logoutButton'),
  connectionStatus: document.querySelector('#connectionStatus'),
  pageTitle: document.querySelector('#pageTitle'),
  pageSubtitle: document.querySelector('#pageSubtitle'),
  navItems: document.querySelectorAll('[data-page]'),
  pagePanels: document.querySelectorAll('[data-page-panel]'),
  quickActions: document.querySelectorAll('[data-go-to]'),
  activeVersion: document.querySelector('#activeVersion'),
  overviewReleaseTotal: document.querySelector('#overviewReleaseTotal'),
  overviewActiveLicenses: document.querySelector('#overviewActiveLicenses'),
  overviewUnusedCodes: document.querySelector('#overviewUnusedCodes'),
  overviewPendingFeedback: document.querySelector('#overviewPendingFeedback'),
  manifestUrl: document.querySelector('#manifestUrl'),
  copyManifestButton: document.querySelector('#copyManifestButton'),
  uploadForm: document.querySelector('#uploadForm'),
  releaseVersion: document.querySelector('#releaseVersion'),
  releasePlatformInputs: document.querySelectorAll('input[name="platform"]'),
  releaseArchitecture: document.querySelector('#releaseArchitecture'),
  releaseFile: document.querySelector('#releaseFile'),
  releaseFileLabel: document.querySelector('#releaseFileLabel'),
  releaseNotes: document.querySelector('#releaseNotes'),
  uploadButton: document.querySelector('#uploadButton'),
  uploadProgress: document.querySelector('#uploadProgress'),
  uploadProgressBar: document.querySelector('#uploadProgressBar'),
  uploadProgressText: document.querySelector('#uploadProgressText'),
  refreshButton: document.querySelector('#refreshButton'),
  releasePageTotal: document.querySelector('#releasePageTotal'),
  releasePagePublished: document.querySelector('#releasePagePublished'),
  releasePageDrafts: document.querySelector('#releasePageDrafts'),
  releaseRows: document.querySelector('#releaseRows'),
  emptyReleases: document.querySelector('#emptyReleases'),
  refreshActivationButton: document.querySelector('#refreshActivationButton'),
  generateCodeForm: document.querySelector('#generateCodeForm'),
  activationCount: document.querySelector('#activationCount'),
  activationExpiry: document.querySelector('#activationExpiry'),
  activationNote: document.querySelector('#activationNote'),
  generateCodeButton: document.querySelector('#generateCodeButton'),
  activationTotal: document.querySelector('#activationTotal'),
  activationUnused: document.querySelector('#activationUnused'),
  activationActive: document.querySelector('#activationActive'),
  activationRevoked: document.querySelector('#activationRevoked'),
  activationRows: document.querySelector('#activationRows'),
  emptyActivations: document.querySelector('#emptyActivations'),
  refreshFeedbackButton: document.querySelector('#refreshFeedbackButton'),
  feedbackTotal: document.querySelector('#feedbackTotal'),
  feedbackPending: document.querySelector('#feedbackPending'),
  feedbackInProgress: document.querySelector('#feedbackInProgress'),
  feedbackResolved: document.querySelector('#feedbackResolved'),
  feedbackClosed: document.querySelector('#feedbackClosed'),
  feedbackRows: document.querySelector('#feedbackRows'),
  emptyFeedback: document.querySelector('#emptyFeedback'),
  confirmDialog: document.querySelector('#confirmDialog'),
  confirmTitle: document.querySelector('#confirmTitle'),
  confirmMessage: document.querySelector('#confirmMessage'),
  confirmButton: document.querySelector('#confirmButton'),
  generatedCodesDialog: document.querySelector('#generatedCodesDialog'),
  generatedCodesText: document.querySelector('#generatedCodesText'),
  copyGeneratedCodesButton: document.querySelector('#copyGeneratedCodesButton'),
  toast: document.querySelector('#toast')
};

let csrfToken = '';
let toastTimer;

const pages = {
  overview: ['概览', '发布与授权运行状态'],
  releases: ['版本发布', '上传安装包并维护发布记录'],
  activations: ['激活授权', '管理激活码与设备授权'],
  feedback: ['问题反馈', '查看问题与建议并更新处理状态']
};

function navigateTo(pageName) {
  const selectedPage = pages[pageName] ? pageName : 'overview';
  const [title, subtitle] = pages[selectedPage];
  elements.pageTitle.textContent = title;
  elements.pageSubtitle.textContent = subtitle;

  for (const item of elements.navItems) {
    const selected = item.dataset.page === selectedPage;
    if (selected) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }

  for (const panel of elements.pagePanels) {
    panel.hidden = panel.dataset.pagePanel !== selectedPage;
  }

  if (window.location.hash !== `#${selectedPage}`) {
    window.history.replaceState(null, '', `#${selectedPage}`);
  }
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function showToast(message, tone = '') {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle('error', tone === 'error');
  elements.toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 3200);
}

function showLogin(message = '') {
  csrfToken = '';
  elements.loginError.textContent = message;
  elements.loginView.hidden = false;
  elements.adminView.hidden = true;
}

function showAdmin(session) {
  csrfToken = session.csrfToken;
  elements.loginView.hidden = true;
  elements.adminView.hidden = false;
  elements.connectionStatus.textContent = '管理服务正常';
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

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return '-';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

function cell(className = '') {
  const node = document.createElement('td');
  if (className) node.className = className;
  return node;
}

function actionButton(label, className, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `button ${className}`;
  button.textContent = label;
  button.addEventListener('click', handler);
  return button;
}

function releaseApiPath(release) {
  return `/api/admin/releases/${encodeURIComponent(release.platform)}/${encodeURIComponent(release.architecture)}/${encodeURIComponent(release.version)}`;
}

function platformLabel(release) {
  const system = release.platform === 'macos' ? 'macOS' : 'Windows';
  return `${system} / ${release.architecture}`;
}

function selectedReleasePlatform() {
  return Array.from(elements.releasePlatformInputs)
    .find((input) => input.checked)?.value || 'windows';
}

function syncUploadTarget() {
  const isMac = selectedReleasePlatform() === 'macos';
  const choices = isMac
    ? [['arm64', 'Apple Silicon'], ['x86_64', 'Intel']]
    : [['x64', 'x64']];
  const previous = elements.releaseArchitecture.value;
  elements.releaseArchitecture.replaceChildren(...choices.map(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
  }));
  if (choices.some(([value]) => value === previous)) elements.releaseArchitecture.value = previous;
  elements.releaseFile.value = '';
  elements.releaseFile.accept = isMac ? '.zip,application/zip,application/octet-stream' : '.exe,application/octet-stream';
  elements.releaseFileLabel.textContent = isMac ? 'macOS 更新包 ZIP' : 'Windows 安装包 EXE';
}

function confirmAction({ title, message, confirmLabel = '确认', danger = false }) {
  elements.confirmTitle.textContent = title;
  elements.confirmMessage.textContent = message;
  elements.confirmButton.textContent = confirmLabel;
  elements.confirmButton.className = `button ${danger ? 'button-danger' : 'button-primary'}`;
  elements.confirmDialog.showModal();
  return new Promise((resolve) => {
    elements.confirmDialog.addEventListener('close', () => {
      resolve(elements.confirmDialog.returnValue === 'confirm');
    }, { once: true });
  });
}

async function publishRelease(release) {
  const confirmed = await confirmAction({
    title: `发布 ${platformLabel(release)} v${release.version}`,
    message: '发布后，桌搭子客户端会立即检测到该版本。',
    confirmLabel: '确认发布'
  });
  if (!confirmed) return;
  try {
    const result = await api(`${releaseApiPath(release)}/publish`, { method: 'POST' });
    showToast(`${platformLabel(result.release)} v${result.release.version} 已发布，签名和 SHA-256 校验通过`);
    await loadReleases();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function deleteRelease(release) {
  const confirmed = await confirmAction({
    title: `删除 ${platformLabel(release)} v${release.version}`,
    message: '安装包和版本记录将永久删除。',
    confirmLabel: '删除版本',
    danger: true
  });
  if (!confirmed) return;
  try {
    await api(releaseApiPath(release), { method: 'DELETE' });
    showToast(`${platformLabel(release)} v${release.version} 已删除`);
    await loadReleases();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function renderReleases(payload) {
  const activeEntries = Object.entries(payload.activeVersions || {});
  elements.activeVersion.textContent = activeEntries.length
    ? activeEntries.map(([target, version]) => `${target} v${version}`).join(' / ')
    : '尚未发布';
  elements.overviewReleaseTotal.textContent = payload.releases.length;
  elements.releasePageTotal.textContent = payload.releases.length;
  elements.releasePagePublished.textContent = payload.releases
    .filter((release) => release.publishedAt).length;
  elements.releasePageDrafts.textContent = payload.releases
    .filter((release) => !release.publishedAt).length;
  elements.manifestUrl.value = payload.manifestUrl || '';
  elements.releaseRows.replaceChildren();
  elements.emptyReleases.hidden = payload.releases.length > 0;

  for (const release of payload.releases) {
    const row = document.createElement('tr');

    const versionCell = cell('version-cell');
    const version = document.createElement('strong');
    version.textContent = `v${release.version}`;
    const notes = document.createElement('span');
    notes.textContent = release.notes ? release.notes.split('\n')[0] : '无更新说明';
    versionCell.append(version, notes);

    const platformCell = cell();
    platformCell.textContent = platformLabel(release);

    const statusCell = cell();
    const status = document.createElement('span');
    const statusClass = release.active ? 'active' : release.publishedAt ? 'published' : 'draft';
    status.className = `status-badge ${statusClass}`;
    status.textContent = release.active ? '当前发布' : release.publishedAt ? '已发布' : '草稿';
    statusCell.append(status);

    const fileCell = cell('file-cell');
    const fileName = document.createElement('strong');
    fileName.textContent = release.fileName;
    const fileSize = document.createElement('span');
    fileSize.textContent = formatBytes(release.size);
    fileCell.append(fileName, fileSize);

    const hashCell = cell('hash');
    hashCell.title = release.sha256;
    hashCell.textContent = `${release.sha256.slice(0, 12)}…${release.sha256.slice(-8)}`;

    const dateCell = cell();
    dateCell.textContent = formatDate(release.createdAt);

    const actionsCell = cell();
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    if (!release.active) {
      actions.append(actionButton('发布', 'button-secondary', () => publishRelease(release)));
      actions.append(actionButton('删除', 'button-danger', () => deleteRelease(release)));
    }
    actionsCell.append(actions);

    row.append(versionCell, platformCell, statusCell, fileCell, hashCell, dateCell, actionsCell);
    elements.releaseRows.append(row);
  }
}

const activationStatus = {
  unused: ['未使用', ''],
  expired: ['已过期', 'expired'],
  used: ['已使用', 'active'],
  revoked: ['已撤销', 'revoked']
};

async function getActivationCode(item) {
  const payload = await api(`/api/admin/activation-codes/${encodeURIComponent(item.id)}/reveal`, { method: 'POST' });
  return payload.code;
}

async function revokeLicense(item) {
  const confirmed = await confirmAction({
    title: `撤销授权 ${item.maskedCode}`,
    message: '撤销后，该设备仍可运行桌搭子，但不能再检查或下载更新。',
    confirmLabel: '撤销授权',
    danger: true
  });
  if (!confirmed) return;
  try {
    await api(`/api/admin/licenses/${encodeURIComponent(item.license.id)}/revoke`, { method: 'POST' });
    showToast('设备授权已撤销');
    await loadActivations();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function renderActivations(payload) {
  const summary = payload.summary || {};
  elements.overviewActiveLicenses.textContent = summary.active || 0;
  elements.overviewUnusedCodes.textContent = summary.unused || 0;
  elements.activationTotal.textContent = summary.total || 0;
  elements.activationUnused.textContent = summary.unused || 0;
  elements.activationActive.textContent = summary.active || 0;
  elements.activationRevoked.textContent = summary.revoked || 0;
  elements.activationRows.replaceChildren();
  elements.emptyActivations.hidden = payload.codes.length > 0;

  for (const item of payload.codes) {
    const row = document.createElement('tr');
    const codeCell = cell('activation-code');
    const code = document.createElement('strong');
    code.textContent = item.maskedCode;
    codeCell.append(code);
    if (!item.canReveal) {
      const legacyHint = document.createElement('span');
      legacyHint.textContent = '旧码无法恢复';
      codeCell.append(legacyHint);
    }

    const effectiveStatus = item.license?.status === 'revoked' ? 'revoked' : item.status;
    const [statusLabel, statusClass] = activationStatus[effectiveStatus] || ['未知', ''];
    const statusCell = cell();
    const status = document.createElement('span');
    status.className = `status-badge ${statusClass}`.trim();
    status.textContent = statusLabel;
    statusCell.append(status);

    const noteCell = cell();
    noteCell.textContent = item.note || '-';

    const dateCell = cell('date-stack');
    const created = document.createElement('span');
    created.textContent = `生成 ${formatDate(item.createdAt)}`;
    const expires = document.createElement('span');
    expires.textContent = `到期 ${formatDate(item.expiresAt)}`;
    dateCell.append(created, expires);

    const licenseCell = cell('license-cell');
    if (item.license) {
      const device = document.createElement('strong');
      device.textContent = `设备 …${item.license.installationSuffix}`;
      const detail = document.createElement('span');
      const checkedAt = item.license.lastUpdateAt ? formatDate(item.license.lastUpdateAt) : '尚未检查更新';
      detail.textContent = `v${item.license.appVersion || '-'} · ${checkedAt}`;
      licenseCell.append(device, detail);
    } else {
      licenseCell.textContent = '-';
    }

    const actionsCell = cell();
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    if (item.canReveal) {
      let revealedCode = '';
      const viewButton = actionButton('查看', 'button-secondary', async () => {
        if (revealedCode && code.textContent === revealedCode) {
          code.textContent = item.maskedCode;
          viewButton.textContent = '查看';
          return;
        }
        viewButton.disabled = true;
        try {
          revealedCode = revealedCode || await getActivationCode(item);
          code.textContent = revealedCode;
          viewButton.textContent = '隐藏';
        } catch (error) {
          showToast(error.message, 'error');
        } finally {
          viewButton.disabled = false;
        }
      });
      const copyButton = actionButton('复制', 'button-secondary', async () => {
        copyButton.disabled = true;
        try {
          revealedCode = revealedCode || await getActivationCode(item);
          await navigator.clipboard.writeText(revealedCode);
          showToast('激活码已复制');
        } catch (error) {
          showToast(error.message || '复制失败', 'error');
        } finally {
          copyButton.disabled = false;
        }
      });
      actions.append(viewButton, copyButton);
    }
    if (item.license?.status === 'active') {
      actions.append(actionButton('撤销', 'button-danger', () => revokeLicense(item)));
    }
    actionsCell.append(actions);
    row.append(codeCell, statusCell, noteCell, dateCell, licenseCell, actionsCell);
    elements.activationRows.append(row);
  }
}

async function loadActivations() {
  elements.refreshActivationButton.disabled = true;
  try {
    renderActivations(await api('/api/admin/activation-codes'));
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    elements.refreshActivationButton.disabled = false;
  }
}

const feedbackTypes = {
  problem: '问题反馈',
  suggestion: '功能建议'
};

const feedbackStatuses = {
  pending: '待处理',
  in_progress: '进行中',
  resolved: '已处理',
  closed: '已关闭'
};

async function saveFeedback(item, statusSelect, noteInput, button) {
  button.disabled = true;
  try {
    await api(`/api/admin/feedback/${encodeURIComponent(item.id)}`, {
      method: 'PATCH',
      body: {
        status: statusSelect.value,
        adminNote: noteInput.value.trim()
      }
    });
    showToast('反馈状态已保存');
    await loadFeedback();
  } catch (error) {
    showToast(error.message, 'error');
    button.disabled = false;
  }
}

function renderFeedback(payload) {
  const summary = payload.summary || {};
  const active = (summary.pending || 0) + (summary.inProgress || 0);
  elements.overviewPendingFeedback.textContent = active;
  elements.feedbackTotal.textContent = summary.total || 0;
  elements.feedbackPending.textContent = summary.pending || 0;
  elements.feedbackInProgress.textContent = summary.inProgress || 0;
  elements.feedbackResolved.textContent = summary.resolved || 0;
  elements.feedbackClosed.textContent = summary.closed || 0;
  elements.feedbackRows.replaceChildren();
  elements.emptyFeedback.hidden = payload.items.length > 0;

  for (const item of payload.items) {
    const row = document.createElement('tr');
    const feedbackCell = cell('feedback-content');
    const type = document.createElement('span');
    type.className = `feedback-type ${item.type}`;
    type.textContent = feedbackTypes[item.type] || '反馈';
    const title = document.createElement('strong');
    title.textContent = item.title;
    const content = document.createElement('span');
    content.className = 'feedback-message';
    content.textContent = item.content;
    const meta = document.createElement('span');
    meta.className = 'feedback-meta';
    const device = document.createElement('span');
    device.textContent = `设备 …${item.installationSuffix} · ${item.platform || '-'} v${item.appVersion || '-'}`;
    const dates = document.createElement('span');
    dates.textContent = `提交 ${formatDate(item.createdAt)} · 更新 ${formatDate(item.updatedAt)}`;
    meta.append(device, dates);
    feedbackCell.append(type, title, content, meta);

    const statusCell = cell();
    const statusSelect = document.createElement('select');
    statusSelect.className = 'feedback-status-select';
    statusSelect.setAttribute('aria-label', `反馈“${item.title}”的状态`);
    for (const [value, label] of Object.entries(feedbackStatuses)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      option.selected = value === item.status;
      statusSelect.append(option);
    }
    statusCell.append(statusSelect);

    const noteCell = cell('feedback-note-cell');
    const noteInput = document.createElement('textarea');
    noteInput.rows = 3;
    noteInput.maxLength = 1000;
    noteInput.placeholder = '可选，客户端可查看';
    noteInput.value = item.adminNote || '';
    noteCell.append(noteInput);

    const actionsCell = cell();
    const saveButton = actionButton('保存', 'button-secondary', () => (
      saveFeedback(item, statusSelect, noteInput, saveButton)
    ));
    actionsCell.append(saveButton);
    row.append(feedbackCell, statusCell, noteCell, actionsCell);
    elements.feedbackRows.append(row);
  }
}

async function loadFeedback() {
  elements.refreshFeedbackButton.disabled = true;
  try {
    renderFeedback(await api('/api/admin/feedback'));
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    elements.refreshFeedbackButton.disabled = false;
  }
}

async function loadDashboard() {
  await Promise.all([loadReleases(), loadActivations(), loadFeedback()]);
}

async function loadReleases() {
  elements.refreshButton.disabled = true;
  try {
    renderReleases(await api('/api/admin/releases'));
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    elements.refreshButton.disabled = false;
  }
}

function uploadBinary(uploadUrl, file) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', uploadUrl);
    request.responseType = 'json';
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.setRequestHeader('X-CSRF-Token', csrfToken);
    request.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      const progress = Math.min(100, Math.round(event.loaded / event.total * 100));
      elements.uploadProgressBar.value = progress;
      elements.uploadProgressText.textContent = `${progress}%`;
    });
    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) return resolve(request.response);
      const error = new Error(request.response?.error || `上传失败 (${request.status})`);
      error.status = request.status;
      reject(error);
    });
    request.addEventListener('error', () => reject(new Error('上传连接中断')));
    request.addEventListener('abort', () => reject(new Error('上传已取消')));
    request.send(file);
  });
}

elements.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  elements.loginError.textContent = '';
  const submit = elements.loginForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  const data = new FormData(elements.loginForm);
  try {
    const session = await api('/api/admin/login', {
      method: 'POST',
      body: { username: data.get('username'), password: data.get('password') }
    });
    elements.loginForm.reset();
    elements.loginForm.elements.username.value = 'admin';
    showAdmin(session);
    await loadDashboard();
  } catch (error) {
    elements.loginError.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

elements.logoutButton.addEventListener('click', async () => {
  try {
    await api('/api/admin/logout', { method: 'POST' });
  } catch {}
  showLogin();
});

syncUploadTarget();
for (const input of elements.releasePlatformInputs) {
  input.addEventListener('change', syncUploadTarget);
}

elements.uploadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = elements.releaseFile.files[0];
  if (!file) return;
  elements.uploadButton.disabled = true;
  elements.uploadProgress.hidden = false;
  elements.uploadProgressBar.value = 0;
  elements.uploadProgressText.textContent = '0%';
  try {
    const task = await api('/api/admin/releases', {
      method: 'POST',
      body: {
        platform: selectedReleasePlatform(),
        architecture: elements.releaseArchitecture.value,
        version: elements.releaseVersion.value.trim(),
        fileName: file.name,
        fileSize: file.size,
        notes: elements.releaseNotes.value.trim()
      }
    });
    await uploadBinary(task.uploadUrl, file);
    elements.uploadProgressBar.value = 100;
    elements.uploadProgressText.textContent = '100%';
    elements.uploadForm.reset();
    syncUploadTarget();
    showToast('安装包已上传为草稿');
    await loadReleases();
  } catch (error) {
    if (error.status === 401) showLogin('登录已失效，请重新登录');
    showToast(error.message, 'error');
  } finally {
    elements.uploadButton.disabled = false;
    window.setTimeout(() => {
      elements.uploadProgress.hidden = true;
    }, 800);
  }
});

elements.refreshButton.addEventListener('click', loadReleases);
elements.refreshActivationButton.addEventListener('click', loadActivations);
elements.refreshFeedbackButton.addEventListener('click', loadFeedback);

for (const item of elements.navItems) {
  item.addEventListener('click', () => navigateTo(item.dataset.page));
}

for (const action of elements.quickActions) {
  action.addEventListener('click', () => navigateTo(action.dataset.goTo));
}

window.addEventListener('hashchange', () => {
  if (!elements.adminView.hidden) navigateTo(window.location.hash.slice(1));
});

elements.generateCodeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  elements.generateCodeButton.disabled = true;
  try {
    const generated = await api('/api/admin/activation-codes', {
      method: 'POST',
      body: {
        count: Number(elements.activationCount.value),
        expiresInDays: Number(elements.activationExpiry.value),
        note: elements.activationNote.value.trim()
      }
    });
    elements.generatedCodesText.value = generated.codes.join('\n');
    elements.generatedCodesDialog.showModal();
    elements.activationNote.value = '';
    await loadActivations();
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    elements.generateCodeButton.disabled = false;
  }
});

elements.copyGeneratedCodesButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(elements.generatedCodesText.value);
    showToast('激活码已复制');
  } catch {
    elements.generatedCodesText.select();
    showToast('激活码已选中');
  }
});

elements.copyManifestButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(elements.manifestUrl.value);
    showToast('更新清单地址已复制');
  } catch {
    elements.manifestUrl.select();
    showToast('已选中更新清单地址');
  }
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
