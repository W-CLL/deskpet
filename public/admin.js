const elements = {
  loginView: document.querySelector('#loginView'),
  loginForm: document.querySelector('#loginForm'),
  loginError: document.querySelector('#loginError'),
  adminView: document.querySelector('#adminView'),
  logoutButton: document.querySelector('#logoutButton'),
  activeVersion: document.querySelector('#activeVersion'),
  manifestUrl: document.querySelector('#manifestUrl'),
  copyManifestButton: document.querySelector('#copyManifestButton'),
  uploadForm: document.querySelector('#uploadForm'),
  releaseVersion: document.querySelector('#releaseVersion'),
  releaseFile: document.querySelector('#releaseFile'),
  releaseNotes: document.querySelector('#releaseNotes'),
  uploadButton: document.querySelector('#uploadButton'),
  uploadProgress: document.querySelector('#uploadProgress'),
  uploadProgressBar: document.querySelector('#uploadProgressBar'),
  uploadProgressText: document.querySelector('#uploadProgressText'),
  refreshButton: document.querySelector('#refreshButton'),
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
  elements.logoutButton.hidden = true;
}

function showAdmin(session) {
  csrfToken = session.csrfToken;
  elements.loginView.hidden = true;
  elements.adminView.hidden = false;
  elements.logoutButton.hidden = false;
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
    title: `发布 v${release.version}`,
    message: '发布后，桌搭子客户端会立即检测到该版本。',
    confirmLabel: '确认发布'
  });
  if (!confirmed) return;
  try {
    const result = await api(`/api/admin/releases/${encodeURIComponent(release.version)}/publish`, { method: 'POST' });
    showToast(`v${result.release.version} 已发布，签名和 SHA-256 校验通过`);
    await loadReleases();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function deleteRelease(release) {
  const confirmed = await confirmAction({
    title: `删除 v${release.version}`,
    message: '安装包和版本记录将永久删除。',
    confirmLabel: '删除版本',
    danger: true
  });
  if (!confirmed) return;
  try {
    await api(`/api/admin/releases/${encodeURIComponent(release.version)}`, { method: 'DELETE' });
    showToast(`v${release.version} 已删除`);
    await loadReleases();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function renderReleases(payload) {
  elements.activeVersion.textContent = payload.activeVersion ? `v${payload.activeVersion}` : '尚未发布';
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

    const statusCell = cell();
    const status = document.createElement('span');
    status.className = `status-badge${release.active ? ' active' : ''}`;
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

    row.append(versionCell, statusCell, fileCell, hashCell, dateCell, actionsCell);
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

async function loadDashboard() {
  await Promise.all([loadReleases(), loadActivations()]);
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
