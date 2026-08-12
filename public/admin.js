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
  adminUrl: document.querySelector('#adminUrl'),
  copyAdminUrlButton: document.querySelector('#copyAdminUrlButton'),
  manifestUrl: document.querySelector('#manifestUrl'),
  siteSettingsForm: document.querySelector('#siteSettingsForm'),
  xianyuUrl: document.querySelector('#xianyuUrl'),
  saveSiteSettingsButton: document.querySelector('#saveSiteSettingsButton'),
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
  resourcePackForm: document.querySelector('#resourcePackForm'),
  resourcePackCategory: document.querySelector('#resourcePackCategory'),
  resourcePackTitle: document.querySelector('#resourcePackTitle'),
  resourcePackDescription: document.querySelector('#resourcePackDescription'),
  resourcePackFile: document.querySelector('#resourcePackFile'),
  resourcePackUploadButton: document.querySelector('#resourcePackUploadButton'),
  resourcePackProgress: document.querySelector('#resourcePackProgress'),
  resourcePackProgressBar: document.querySelector('#resourcePackProgressBar'),
  resourcePackProgressText: document.querySelector('#resourcePackProgressText'),
  refreshResourcePacksButton: document.querySelector('#refreshResourcePacksButton'),
  resourcePackRows: document.querySelector('#resourcePackRows'),
  emptyResourcePacks: document.querySelector('#emptyResourcePacks'),
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
  activationAccounts: document.querySelector('#activationAccounts'),
  activationUnused: document.querySelector('#activationUnused'),
  activationActive: document.querySelector('#activationActive'),
  activationRevoked: document.querySelector('#activationRevoked'),
  activationRows: document.querySelector('#activationRows'),
  emptyActivations: document.querySelector('#emptyActivations'),
  refreshInteractionButton: document.querySelector('#refreshInteractionButton'),
  interactionAccounts: document.querySelector('#interactionAccounts'),
  interactionActiveAccounts: document.querySelector('#interactionActiveAccounts'),
  interactionTotal: document.querySelector('#interactionTotal'),
  interactionHappy: document.querySelector('#interactionHappy'),
  interactionJokes: document.querySelector('#interactionJokes'),
  interactionQuizzes: document.querySelector('#interactionQuizzes'),
  interactionRows: document.querySelector('#interactionRows'),
  emptyInteractions: document.querySelector('#emptyInteractions'),
  refreshCompanionButton: document.querySelector('#refreshCompanionButton'),
  companionProfiles: document.querySelector('#companionProfiles'),
  companionPairs: document.querySelector('#companionPairs'),
  companionSent: document.querySelector('#companionSent'),
  companionReceived: document.querySelector('#companionReceived'),
  companionPending: document.querySelector('#companionPending'),
  companionExpired: document.querySelector('#companionExpired'),
  companionReceiptRate: document.querySelector('#companionReceiptRate'),
  companionStorage: document.querySelector('#companionStorage'),
  companionUpdatedAt: document.querySelector('#companionUpdatedAt'),
  companionRows: document.querySelector('#companionRows'),
  emptyCompanions: document.querySelector('#emptyCompanions'),
  analyticsForm: document.querySelector('#analyticsForm'),
  analyticsFrom: document.querySelector('#analyticsFrom'),
  analyticsTo: document.querySelector('#analyticsTo'),
  refreshAnalyticsButton: document.querySelector('#refreshAnalyticsButton'),
  analyticsVisitors: document.querySelector('#analyticsVisitors'),
  analyticsDownloads: document.querySelector('#analyticsDownloads'),
  analyticsResourceDownloads: document.querySelector('#analyticsResourceDownloads'),
  analyticsClickRate: document.querySelector('#analyticsClickRate'),
  analyticsFirstLaunches: document.querySelector('#analyticsFirstLaunches'),
  analyticsInstallRate: document.querySelector('#analyticsInstallRate'),
  analyticsDownloadActivationRate: document.querySelector('#analyticsDownloadActivationRate'),
  analyticsWeeklyActive: document.querySelector('#analyticsWeeklyActive'),
  analyticsPlatformRows: document.querySelector('#analyticsPlatformRows'),
  analyticsCohortRows: document.querySelector('#analyticsCohortRows'),
  analyticsEmpty: document.querySelector('#analyticsEmpty'),
  refreshContentButton: document.querySelector('#refreshContentButton'),
  contentCatalogVersion: document.querySelector('#contentCatalogVersion'),
  contentActive: document.querySelector('#contentActive'),
  contentJokes: document.querySelector('#contentJokes'),
  contentMath: document.querySelector('#contentMath'),
  contentTrivia: document.querySelector('#contentTrivia'),
  contentRiddles: document.querySelector('#contentRiddles'),
  contentTips: document.querySelector('#contentTips'),
  contentCare: document.querySelector('#contentCare'),
  contentDisabled: document.querySelector('#contentDisabled'),
  contentTypeFilter: document.querySelector('#contentTypeFilter'),
  contentSelectionCount: document.querySelector('#contentSelectionCount'),
  clearContentSelectionButton: document.querySelector('#clearContentSelectionButton'),
  disableSelectedContentButton: document.querySelector('#disableSelectedContentButton'),
  contentBulkType: document.querySelector('#contentBulkType'),
  disableContentTypeButton: document.querySelector('#disableContentTypeButton'),
  contentSelectVisible: document.querySelector('#contentSelectVisible'),
  contentEditorForm: document.querySelector('#contentEditorForm'),
  contentEditorTitle: document.querySelector('#contentEditorTitle'),
  contentEditorState: document.querySelector('#contentEditorState'),
  contentType: document.querySelector('#contentType'),
  contentId: document.querySelector('#contentId'),
  contentDifficulty: document.querySelector('#contentDifficulty'),
  contentLocale: document.querySelector('#contentLocale'),
  contentPrompt: document.querySelector('#contentPrompt'),
  contentAnswer: document.querySelector('#contentAnswer'),
  contentExplanation: document.querySelector('#contentExplanation'),
  contentChoices: document.querySelector('#contentChoices'),
  contentTags: document.querySelector('#contentTags'),
  contentActiveInput: document.querySelector('#contentActiveInput'),
  cancelContentEditButton: document.querySelector('#cancelContentEditButton'),
  saveContentButton: document.querySelector('#saveContentButton'),
  contentImportForm: document.querySelector('#contentImportForm'),
  contentImportFile: document.querySelector('#contentImportFile'),
  contentDisableMissing: document.querySelector('#contentDisableMissing'),
  importContentButton: document.querySelector('#importContentButton'),
  contentRows: document.querySelector('#contentRows'),
  emptyContent: document.querySelector('#emptyContent'),
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
let editingContentId = '';
let contentItems = [];
let visibleActiveContentIds = [];
let contentBulkPending = false;
const selectedContentIds = new Set();

const pages = {
  overview: ['概览', '发布与授权运行状态'],
  releases: ['版本发布', '上传安装包并维护发布记录'],
  activations: ['激活授权', '管理激活码与设备授权'],
  interactions: ['互动统计', '查看账号互动、心情与内容记录'],
  companions: ['搭子联机', '查看配对与 GIF 投递聚合数据'],
  analytics: ['增长数据', '官网访问、下载转化与设备留存'],
  content: ['内容库', '维护客户端在线与离线互动资源'],
  'resource-packs': ['资源包', '上传互动词包和小剧场剧本供官网下载'],
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

function cell(className = '', text) {
  const node = document.createElement('td');
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
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

function createListView(name, { emptyElement, renderPage, matches }) {
  const controls = document.querySelector(`[data-list-controls="${name}"]`);
  const pagination = document.querySelector(`[data-list-pagination="${name}"]`);
  const filterElements = Array.from(controls?.querySelectorAll('[data-list-filter]') || []);
  const pageSize = document.createElement('select');
  pageSize.setAttribute('aria-label', '每页显示条数');
  for (const value of [10, 20, 50, 100]) {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = String(value);
    option.selected = value === 20;
    pageSize.append(option);
  }
  const pageSizeLabel = document.createElement('label');
  pageSizeLabel.className = 'page-size-control';
  const pageSizeText = document.createElement('span');
  pageSizeText.textContent = '每页';
  pageSizeLabel.append(pageSizeText, pageSize);

  const range = document.createElement('span');
  range.className = 'pagination-range';
  const pageLabel = document.createElement('span');
  pageLabel.className = 'pagination-page';
  const previous = document.createElement('button');
  previous.type = 'button';
  previous.className = 'button button-secondary pagination-button';
  previous.textContent = '←';
  previous.title = '上一页';
  previous.setAttribute('aria-label', '上一页');
  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'button button-secondary pagination-button';
  next.textContent = '→';
  next.title = '下一页';
  next.setAttribute('aria-label', '下一页');
  const navigation = document.createElement('div');
  navigation.className = 'pagination-navigation';
  navigation.append(previous, pageLabel, next);
  pagination.replaceChildren(pageSizeLabel, range, navigation);

  let items = [];
  let currentPage = 1;

  function filterValues() {
    return Object.fromEntries(filterElements.map((element) => [element.dataset.listFilter, element.value]));
  }

  function render() {
    const filters = filterValues();
    const filtered = matches ? items.filter((item) => matches(item, filters)) : [...items];
    const size = Number(pageSize.value);
    const pageCount = Math.max(1, Math.ceil(filtered.length / size));
    currentPage = Math.min(currentPage, pageCount);
    const start = (currentPage - 1) * size;
    const visibleItems = filtered.slice(start, start + size);
    renderPage(visibleItems);
    emptyElement.hidden = filtered.length > 0;
    range.textContent = filtered.length
      ? `${start + 1}-${start + visibleItems.length} / ${filtered.length} 条`
      : '0 条';
    pageLabel.textContent = `${currentPage} / ${pageCount}`;
    previous.disabled = currentPage <= 1;
    next.disabled = currentPage >= pageCount;
  }

  for (const element of filterElements) {
    element.addEventListener('change', () => {
      currentPage = 1;
      render();
    });
  }
  pageSize.addEventListener('change', () => {
    currentPage = 1;
    render();
  });
  previous.addEventListener('click', () => {
    if (currentPage <= 1) return;
    currentPage -= 1;
    render();
  });
  next.addEventListener('click', () => {
    currentPage += 1;
    render();
  });

  return {
    setItems(nextItems) {
      items = Array.isArray(nextItems) ? nextItems : [];
      render();
    },
    refresh() {
      render();
    }
  };
}

function releaseStatusKey(release) {
  if (release.active) return 'active';
  return release.publishedAt ? 'published' : 'draft';
}

function activationStatusKey(item) {
  return item.license?.status === 'revoked' ? 'revoked' : item.status;
}

const listViews = {
  releases: createListView('releases', {
    emptyElement: elements.emptyReleases,
    renderPage: renderReleaseRows,
    matches: (item, filters) => (!filters.platform || item.platform === filters.platform)
      && (!filters.status || releaseStatusKey(item) === filters.status)
  }),
  activations: createListView('activations', {
    emptyElement: elements.emptyActivations,
    renderPage: renderActivationRows,
    matches: (item, filters) => (!filters.status || activationStatusKey(item) === filters.status)
      && (!filters.purpose || (item.purpose || 'new_account') === filters.purpose)
  }),
  interactions: createListView('interactions', {
    emptyElement: elements.emptyInteractions,
    renderPage: renderInteractionRows,
    matches: (item, filters) => (!filters.mode || item.profile.mode === filters.mode)
      && (!filters.enabled
        || (item.profile.promptsEnabled ? 'enabled' : 'disabled') === filters.enabled)
  }),
  content: createListView('content', {
    emptyElement: elements.emptyContent,
    renderPage: renderContentRows,
    matches: (item, filters) => (!filters.type || item.type === filters.type)
      && (!filters.active || (item.active ? 'active' : 'disabled') === filters.active)
  }),
  resourcePacks: createListView('resource-packs', {
    emptyElement: elements.emptyResourcePacks,
    renderPage: renderResourcePackRows,
    matches: (item, filters) => !filters.category || item.category === filters.category
  }),
  feedback: createListView('feedback', {
    emptyElement: elements.emptyFeedback,
    renderPage: renderFeedbackRows,
    matches: (item, filters) => (!filters.type || item.type === filters.type)
      && (!filters.status || item.status === filters.status)
  })
};

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
  elements.adminUrl.value = payload.adminUrl || '';
  elements.manifestUrl.value = payload.manifestUrl || '';
  listViews.releases.setItems(payload.releases);
}

function renderReleaseRows(releases) {
  elements.releaseRows.replaceChildren();

  for (const release of releases) {
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
    const statusClass = release.public ? 'active' : release.active ? 'published' : release.publishedAt ? 'published' : 'draft';
    status.className = `status-badge ${statusClass}`;
    status.textContent = release.public ? '官网公开' : release.active ? '当前发布' : release.publishedAt ? '已发布' : '草稿';
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

function resourcePackCategoryLabel(category) {
  return category === 'theater-scripts' ? '小剧场剧本' : '互动词包';
}

async function deleteResourcePack(pack) {
  const confirmed = await confirmAction({
    title: `删除“${pack.title}”`,
    message: '官网上的下载入口和 ZIP 文件将同时删除。',
    confirmLabel: '删除资源包',
    danger: true
  });
  if (!confirmed) return;
  try {
    await api(`/api/admin/resource-packs/${encodeURIComponent(pack.id)}`, { method: 'DELETE' });
    showToast('资源包已删除');
    await loadResourcePacks();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function renderResourcePacks(payload) {
  listViews.resourcePacks.setItems(payload.packs);
}

function renderResourcePackRows(packs) {
  elements.resourcePackRows.replaceChildren();
  for (const pack of packs) {
    const row = document.createElement('tr');
    const titleCell = cell('version-cell');
    const title = document.createElement('strong');
    title.textContent = pack.title;
    const description = document.createElement('span');
    description.textContent = pack.description;
    titleCell.append(title, description);

    const categoryCell = cell();
    categoryCell.textContent = resourcePackCategoryLabel(pack.category);

    const fileCell = cell('file-cell');
    const fileName = document.createElement('strong');
    fileName.textContent = pack.originalName;
    const fileSize = document.createElement('span');
    fileSize.textContent = formatBytes(pack.size);
    fileCell.append(fileName, fileSize);

    const hashCell = cell('hash');
    hashCell.title = pack.sha256;
    hashCell.textContent = `${pack.sha256.slice(0, 12)}…${pack.sha256.slice(-8)}`;

    const dateCell = cell();
    dateCell.textContent = formatDate(pack.createdAt);

    const actionsCell = cell();
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const download = document.createElement('a');
    download.className = 'button button-secondary';
    download.href = pack.url;
    download.textContent = '下载';
    actions.append(download, actionButton('删除', 'button-danger', () => deleteResourcePack(pack)));
    actionsCell.append(actions);

    row.append(titleCell, categoryCell, fileCell, hashCell, dateCell, actionsCell);
    elements.resourcePackRows.append(row);
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

async function createRebindCode(item) {
  const confirmed = await confirmAction({
    title: `生成账号 …${item.account.suffix} 的换机码`,
    message: '换机码在新设备成功绑定后才会撤销原设备授权，有效期为 24 小时。',
    confirmLabel: '生成换机码'
  });
  if (!confirmed) return;
  try {
    const generated = await api(
      `/api/admin/accounts/${encodeURIComponent(item.account.id)}/rebind-code`,
      { method: 'POST', body: { expiresInHours: 24 } }
    );
    elements.generatedCodesText.value = generated.code;
    elements.generatedCodesDialog.showModal();
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
  elements.activationAccounts.textContent = summary.accounts || 0;
  elements.activationUnused.textContent = summary.unused || 0;
  elements.activationActive.textContent = summary.active || 0;
  elements.activationRevoked.textContent = summary.revoked || 0;
  listViews.activations.setItems(payload.codes);
}

function renderActivationRows(codes) {
  elements.activationRows.replaceChildren();
  const accountsWithRebindAction = new Set();

  for (const item of codes) {
    const row = document.createElement('tr');
    const codeCell = cell('activation-code');
    const code = document.createElement('strong');
    code.textContent = item.maskedCode;
    codeCell.append(code);
    if (item.purpose === 'rebind') {
      const rebindHint = document.createElement('span');
      rebindHint.textContent = '换机码';
      codeCell.append(rebindHint);
    }
    if (!item.canReveal) {
      const legacyHint = document.createElement('span');
      legacyHint.textContent = '旧码无法恢复';
      codeCell.append(legacyHint);
    }

    const effectiveStatus = activationStatusKey(item);
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
    if (item.account) {
      const account = document.createElement('strong');
      account.textContent = `账号 …${item.account.suffix}`;
      licenseCell.append(account);
    }
    if (item.license) {
      const device = document.createElement('span');
      device.textContent = `设备 …${item.license.installationSuffix}`;
      const detail = document.createElement('span');
      const checkedAt = item.license.lastUpdateAt ? formatDate(item.license.lastUpdateAt) : '尚未检查更新';
      detail.textContent = `v${item.license.appVersion || '-'} · ${checkedAt}`;
      licenseCell.append(device, detail);
    } else if (!item.account) {
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
    if (item.account?.status === 'active' && !accountsWithRebindAction.has(item.account.id)) {
      actions.append(actionButton('换机码', 'button-secondary', () => createRebindCode(item)));
      accountsWithRebindAction.add(item.account.id);
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
  listViews.feedback.setItems(payload.items);
}

function renderFeedbackRows(items) {
  elements.feedbackRows.replaceChildren();

  for (const item of items) {
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

const interactionModes = {
  quiet: '安静',
  standard: '标准',
  lively: '热闹'
};

function renderInteractions(payload) {
  const summary = payload.summary || {};
  elements.interactionAccounts.textContent = summary.accounts || 0;
  elements.interactionActiveAccounts.textContent = summary.interactingAccounts || 0;
  elements.interactionTotal.textContent = summary.totalInteractions || 0;
  elements.interactionHappy.textContent = summary.moodHappy || 0;
  elements.interactionJokes.textContent = summary.jokesRevealed || 0;
  elements.interactionQuizzes.textContent = summary.quizzesAnswered || 0;
  listViews.interactions.setItems(payload.accounts);
}

function renderInteractionRows(accounts) {
  elements.interactionRows.replaceChildren();

  for (const item of accounts) {
    const row = document.createElement('tr');
    const accountCell = cell('interaction-account');
    const account = document.createElement('strong');
    account.textContent = `账号 …${item.accountSuffix}`;
    const created = document.createElement('span');
    created.textContent = `建档 ${formatDate(item.profile.createdAt)}`;
    accountCell.append(account, created);

    const settingsCell = cell('interaction-settings');
    const mode = document.createElement('strong');
    mode.textContent = `${interactionModes[item.profile.mode] || item.profile.mode}模式`;
    const enabled = document.createElement('span');
    enabled.textContent = item.profile.promptsEnabled ? '随机互动已开启' : '随机互动已关闭';
    settingsCell.append(mode, enabled);

    const totalCell = cell('interaction-number');
    totalCell.textContent = item.summary.totalInteractions;

    const moodCell = cell('interaction-detail');
    const moodTotal = document.createElement('strong');
    moodTotal.textContent = `共 ${item.summary.moodResponses} 次`;
    const moodBreakdown = document.createElement('span');
    moodBreakdown.textContent = `开心 ${item.summary.moodHappy} · 一般 ${item.summary.moodOkay} · 低落 ${item.summary.moodLow}`;
    moodCell.append(moodTotal, moodBreakdown);

    const contentCell = cell('interaction-detail');
    const contentTotal = document.createElement('strong');
    contentTotal.textContent = `笑话 ${item.summary.jokesRevealed} · 答题 ${item.summary.quizzesAnswered}`;
    const correct = document.createElement('span');
    correct.textContent = `答对 ${item.summary.quizzesCorrect} · 展示 ${item.summary.contentShown}`;
    contentCell.append(contentTotal, correct);

    const recentCell = cell('date-stack');
    const recent = document.createElement('span');
    recent.textContent = item.summary.lastInteractionAt
      ? formatDate(item.summary.lastInteractionAt)
      : '尚无互动';
    recentCell.append(recent);

    row.append(accountCell, settingsCell, totalCell, moodCell, contentCell, recentCell);
    elements.interactionRows.append(row);
  }
}

async function loadInteractions() {
  elements.refreshInteractionButton.disabled = true;
  try {
    renderInteractions(await api('/api/admin/interactions'));
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    elements.refreshInteractionButton.disabled = false;
  }
}

function renderCompanions(payload) {
  const summary = payload.summary || {};
  elements.companionProfiles.textContent = summary.profiles || 0;
  elements.companionPairs.textContent = summary.activePairs || 0;
  elements.companionSent.textContent = summary.sent || 0;
  elements.companionReceived.textContent = summary.received || 0;
  elements.companionPending.textContent = summary.pending || 0;
  elements.companionExpired.textContent = summary.expired || 0;
  elements.companionReceiptRate.textContent = summary.receiptRate === null
    ? '-'
    : formatAnalyticsRate(summary.receiptRate);
  elements.companionStorage.textContent = formatBytes(summary.storageBytes || 0);
  elements.companionUpdatedAt.textContent = `更新于 ${formatDate(payload.generatedAt)}`;
  elements.companionRows.replaceChildren();

  const daily = payload.daily || [];
  for (const item of daily) {
    const row = document.createElement('tr');
    row.append(
      cell('', item.date),
      cell('', item.sent),
      cell('', item.received),
      cell('', item.expired),
      cell('', item.sent > 0 ? formatAnalyticsRate(item.received / item.sent) : '-')
    );
    elements.companionRows.append(row);
  }
  elements.emptyCompanions.hidden = daily.length > 0;
}

async function loadCompanions() {
  elements.refreshCompanionButton.disabled = true;
  try {
    renderCompanions(await api('/api/admin/companions'));
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    elements.refreshCompanionButton.disabled = false;
  }
}

const contentTypeLabels = {
  joke: '冷笑话',
  math: '数学题',
  trivia: '趣味知识',
  riddle: '脑筋急转弯',
  tip: '生活小贴士',
  care: '关怀内容'
};

function resetContentEditor() {
  editingContentId = '';
  elements.contentEditorForm.reset();
  elements.contentType.value = 'joke';
  elements.contentDifficulty.value = '1';
  elements.contentLocale.value = 'zh-CN';
  elements.contentActiveInput.checked = true;
  elements.contentId.readOnly = false;
  elements.contentEditorTitle.textContent = '新增内容';
  elements.contentEditorState.textContent = '新内容';
  elements.cancelContentEditButton.hidden = true;
  elements.saveContentButton.textContent = '新增内容';
}

function editContent(item) {
  editingContentId = item.id;
  elements.contentType.value = item.type;
  elements.contentId.value = item.id;
  elements.contentId.readOnly = true;
  elements.contentDifficulty.value = String(item.difficulty);
  elements.contentLocale.value = item.locale;
  elements.contentPrompt.value = item.prompt;
  elements.contentAnswer.value = item.answer;
  elements.contentExplanation.value = item.explanation || '';
  elements.contentChoices.value = item.choices.join('\n');
  elements.contentTags.value = item.tags.join('，');
  elements.contentActiveInput.checked = item.active;
  elements.contentEditorTitle.textContent = '编辑内容';
  elements.contentEditorState.textContent = `修订版 ${item.revision}`;
  elements.cancelContentEditButton.hidden = false;
  elements.saveContentButton.textContent = '保存修改';
  elements.contentEditorForm.scrollIntoView({ block: 'start', behavior: 'smooth' });
  elements.contentPrompt.focus({ preventScroll: true });
}

function contentFormPayload() {
  const choices = elements.contentChoices.value
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
  const tags = elements.contentTags.value
    .split(/[,，\n]/)
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    ...(elements.contentId.value.trim() ? { id: elements.contentId.value.trim() } : {}),
    type: elements.contentType.value,
    prompt: elements.contentPrompt.value.trim(),
    answer: elements.contentAnswer.value.trim(),
    explanation: elements.contentExplanation.value.trim(),
    choices,
    tags,
    difficulty: Number(elements.contentDifficulty.value),
    locale: elements.contentLocale.value.trim(),
    active: elements.contentActiveInput.checked
  };
}

function selectedActiveContentIds() {
  const activeIds = new Set(contentItems.filter((item) => item.active).map((item) => item.id));
  return [...selectedContentIds].filter((id) => activeIds.has(id));
}

function updateContentBulkControls() {
  const selectedIds = selectedActiveContentIds();
  const selectedVisible = visibleActiveContentIds.filter((id) => selectedContentIds.has(id));
  const type = elements.contentBulkType.value;
  const activeTypeCount = type
    ? contentItems.filter((item) => item.active && item.type === type).length
    : 0;

  elements.contentSelectionCount.textContent = `已选 ${selectedIds.length} 条`;
  elements.clearContentSelectionButton.disabled = contentBulkPending || selectedIds.length === 0;
  elements.disableSelectedContentButton.disabled = contentBulkPending
    || selectedIds.length === 0
    || selectedIds.length > 500;
  elements.disableSelectedContentButton.title = selectedIds.length > 500
    ? '单次最多批量禁用 500 条内容'
    : '';
  elements.disableContentTypeButton.disabled = contentBulkPending || !type || activeTypeCount === 0;
  elements.disableContentTypeButton.textContent = activeTypeCount
    ? `禁用该类型 (${activeTypeCount})`
    : '禁用该类型';
  elements.contentSelectVisible.disabled = contentBulkPending || visibleActiveContentIds.length === 0;
  elements.contentSelectVisible.checked = visibleActiveContentIds.length > 0
    && selectedVisible.length === visibleActiveContentIds.length;
  elements.contentSelectVisible.indeterminate = selectedVisible.length > 0
    && selectedVisible.length < visibleActiveContentIds.length;
}

async function disableSelectedContent() {
  const ids = selectedActiveContentIds();
  if (!ids.length || ids.length > 500) return;
  const confirmed = await confirmAction({
    title: `批量禁用 ${ids.length} 条内容`,
    message: '禁用后，新的在线批次和离线包将不再包含这些内容。',
    confirmLabel: '确认批量禁用',
    danger: true
  });
  if (!confirmed) return;

  contentBulkPending = true;
  updateContentBulkControls();
  try {
    const result = await api('/api/admin/content/bulk-disable', {
      method: 'PATCH',
      body: { ids }
    });
    for (const id of ids) selectedContentIds.delete(id);
    if (ids.includes(editingContentId)) resetContentEditor();
    showToast(`批量禁用完成：停用 ${result.disabled} 条，未变更 ${result.unchanged} 条`);
    await loadContent();
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    contentBulkPending = false;
    updateContentBulkControls();
  }
}

async function disableContentType() {
  const type = elements.contentBulkType.value;
  if (!type) return;
  const activeCount = contentItems.filter((item) => item.active && item.type === type).length;
  if (!activeCount) return;
  const typeLabel = contentTypeLabels[type] || type;
  const confirmed = await confirmAction({
    title: `禁用全部${typeLabel}`,
    message: `当前 ${activeCount} 条启用中的${typeLabel}都会被停用。`,
    confirmLabel: '确认按类型禁用',
    danger: true
  });
  if (!confirmed) return;

  contentBulkPending = true;
  updateContentBulkControls();
  try {
    const result = await api('/api/admin/content/bulk-disable', {
      method: 'PATCH',
      body: { type }
    });
    if (contentItems.find((item) => item.id === editingContentId)?.type === type) {
      resetContentEditor();
    }
    showToast(`${typeLabel}已批量禁用：停用 ${result.disabled} 条，未变更 ${result.unchanged} 条`);
    await loadContent();
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    contentBulkPending = false;
    updateContentBulkControls();
  }
}

async function setContentActive(item, active) {
  if (!active) {
    const confirmed = await confirmAction({
      title: `停用 ${item.id}`,
      message: '停用后，新的批次和离线包将不再包含这条内容。',
      confirmLabel: '停用内容',
      danger: true
    });
    if (!confirmed) return;
  }
  try {
    await api(`/api/admin/content/${encodeURIComponent(item.id)}`, active
      ? { method: 'PATCH', body: { active: true } }
      : { method: 'DELETE' });
    showToast(active ? '内容已启用' : '内容已停用');
    if (editingContentId === item.id) resetContentEditor();
    await loadContent();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function renderContent(payload) {
  const summary = payload.summary || {};
  contentItems = Array.isArray(payload.items) ? payload.items : [];
  const activeIds = new Set(contentItems.filter((item) => item.active).map((item) => item.id));
  for (const id of selectedContentIds) {
    if (!activeIds.has(id)) selectedContentIds.delete(id);
  }
  elements.contentCatalogVersion.textContent = payload.catalog?.version || 0;
  elements.contentActive.textContent = summary.active || 0;
  elements.contentJokes.textContent = summary.jokes || 0;
  elements.contentMath.textContent = summary.math || 0;
  elements.contentTrivia.textContent = summary.trivia || 0;
  elements.contentRiddles.textContent = summary.riddles || 0;
  elements.contentTips.textContent = summary.tips || 0;
  elements.contentCare.textContent = summary.care || 0;
  elements.contentDisabled.textContent = summary.disabled || 0;
  listViews.content.setItems(contentItems);
  updateContentBulkControls();
}

function renderContentRows(items) {
  elements.contentRows.replaceChildren();
  visibleActiveContentIds = items.filter((item) => item.active).map((item) => item.id);

  for (const item of items) {
    const row = document.createElement('tr');
    if (!item.active) row.className = 'content-disabled-row';

    const selectionCell = cell('content-selection-cell');
    const selection = document.createElement('input');
    selection.type = 'checkbox';
    selection.checked = item.active && selectedContentIds.has(item.id);
    selection.disabled = !item.active || contentBulkPending;
    selection.setAttribute('aria-label', `选择 ${item.id}`);
    selection.addEventListener('change', () => {
      if (selection.checked) selectedContentIds.add(item.id);
      else selectedContentIds.delete(item.id);
      updateContentBulkControls();
    });
    selectionCell.append(selection);

    const typeCell = cell('content-type-cell');
    const type = document.createElement('strong');
    type.textContent = contentTypeLabels[item.type] || item.type;
    const status = document.createElement('span');
    status.className = `status-badge ${item.active ? 'active' : 'revoked'}`;
    status.textContent = item.active ? '启用' : '停用';
    const id = document.createElement('code');
    id.textContent = item.id;
    typeCell.append(type, status, id);

    const contentCell = cell('content-copy-cell');
    const prompt = document.createElement('strong');
    prompt.textContent = item.prompt;
    const answer = document.createElement('span');
    answer.textContent = `答案：${item.answer}`;
    const explanation = document.createElement('span');
    explanation.textContent = item.explanation || '无解释';
    contentCell.append(prompt, answer, explanation);

    const metaCell = cell('content-meta-cell');
    const difficulty = document.createElement('strong');
    difficulty.textContent = `难度 ${item.difficulty} · ${item.locale}`;
    const tags = document.createElement('span');
    tags.textContent = item.tags.length ? item.tags.join(' · ') : '无标签';
    const choices = document.createElement('span');
    choices.textContent = item.choices.length ? `${item.choices.length} 个选项` : '无选项';
    metaCell.append(difficulty, tags, choices);

    const revisionCell = cell('date-stack');
    const revision = document.createElement('strong');
    revision.textContent = `修订版 ${item.revision}`;
    const updatedAt = document.createElement('span');
    updatedAt.textContent = formatDate(item.updatedAt);
    revisionCell.append(revision, updatedAt);

    const actionsCell = cell();
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.append(actionButton('编辑', 'button-secondary', () => editContent(item)));
    actions.append(actionButton(
      item.active ? '停用' : '启用',
      item.active ? 'button-danger' : 'button-secondary',
      () => setContentActive(item, !item.active)
    ));
    actionsCell.append(actions);

    row.append(selectionCell, typeCell, contentCell, metaCell, revisionCell, actionsCell);
    elements.contentRows.append(row);
  }
  updateContentBulkControls();
}

async function loadContent() {
  elements.refreshContentButton.disabled = true;
  try {
    renderContent(await api('/api/admin/content'));
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    elements.refreshContentButton.disabled = false;
  }
}

function formatAnalyticsRate(value) {
  const rate = Number(value);
  return Number.isFinite(rate) ? `${(rate * 100).toFixed(1)}%` : '-';
}

function analyticsDateValue(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function initializeAnalyticsRange() {
  const end = new Date();
  const start = new Date(end.getTime() - 29 * 24 * 60 * 60 * 1000);
  elements.analyticsFrom.value = analyticsDateValue(start);
  elements.analyticsTo.value = analyticsDateValue(end);
}

function renderAnalytics(payload) {
  const funnel = payload.funnel || {};
  const resourceDownloads = payload.resourceDownloads || {};
  const activity = payload.activity || {};
  elements.analyticsVisitors.textContent = String(funnel.uniqueVisitors || 0);
  elements.analyticsDownloads.textContent = String(funnel.downloadClicks || 0);
  elements.analyticsResourceDownloads.textContent = String(resourceDownloads.downloadClicks || 0);
  elements.analyticsClickRate.textContent = formatAnalyticsRate(funnel.clickRate);
  elements.analyticsFirstLaunches.textContent = String(funnel.firstLaunches || 0);
  elements.analyticsInstallRate.textContent = formatAnalyticsRate(funnel.installRate);
  elements.analyticsDownloadActivationRate.textContent = formatAnalyticsRate(funnel.downloadToActivationRate);
  elements.analyticsWeeklyActive.textContent = String(activity.weeklyActiveDevices || 0);

  elements.analyticsPlatformRows.replaceChildren();
  for (const item of payload.platforms || []) {
    const row = document.createElement('tr');
    for (const value of [item.platform, item.downloadClicks, item.activations, item.activeDevices]) {
      const column = document.createElement('td');
      column.textContent = String(value ?? 0);
      row.append(column);
    }
    elements.analyticsPlatformRows.append(row);
  }

  elements.analyticsCohortRows.replaceChildren();
  for (const item of payload.retention?.cohorts || []) {
    const row = document.createElement('tr');
    for (const value of [item.date, item.size, formatAnalyticsRate(item.d1Rate), formatAnalyticsRate(item.d7Rate), formatAnalyticsRate(item.d30Rate)]) {
      const column = document.createElement('td');
      column.textContent = String(value);
      row.append(column);
    }
    elements.analyticsCohortRows.append(row);
  }
  const hasData = Boolean(
    funnel.uniqueVisitors || funnel.firstLaunches || resourceDownloads.downloadClicks
      || activity.weeklyActiveDevices
      || (payload.platforms || []).length || (payload.retention?.cohorts || []).length
  );
  elements.analyticsEmpty.hidden = hasData;
}

async function loadAnalytics() {
  elements.refreshAnalyticsButton.disabled = true;
  try {
    const query = new URLSearchParams({
      from: elements.analyticsFrom.value,
      to: elements.analyticsTo.value
    });
    renderAnalytics(await api(`/api/admin/analytics?${query}`));
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    elements.refreshAnalyticsButton.disabled = false;
  }
}

async function loadDashboard() {
  await Promise.all([
    loadReleases(),
    loadSiteSettings(),
    loadResourcePacks(),
    loadActivations(),
    loadInteractions(),
    loadCompanions(),
    loadAnalytics(),
    loadContent(),
    loadFeedback()
  ]);
}

async function loadSiteSettings() {
  try {
    const settings = await api('/api/admin/site-settings');
    elements.xianyuUrl.value = settings.xianyuUrl || '';
  } catch (error) {
    showToast(error.message, 'error');
  }
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

async function loadResourcePacks() {
  elements.refreshResourcePacksButton.disabled = true;
  try {
    renderResourcePacks(await api('/api/admin/resource-packs'));
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    elements.refreshResourcePacksButton.disabled = false;
  }
}

function uploadBinary(uploadUrl, file, progressBar, progressText) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', uploadUrl);
    request.responseType = 'json';
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.setRequestHeader('X-CSRF-Token', csrfToken);
    request.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      const progress = Math.min(100, Math.round(event.loaded / event.total * 100));
      progressBar.value = progress;
      progressText.textContent = `${progress}%`;
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

elements.siteSettingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  elements.saveSiteSettingsButton.disabled = true;
  try {
    const settings = await api('/api/admin/site-settings', {
      method: 'PUT',
      body: { xianyuUrl: elements.xianyuUrl.value.trim() }
    });
    elements.xianyuUrl.value = settings.xianyuUrl || '';
    showToast(settings.xianyuUrl ? '官网闲鱼入口已更新' : '官网闲鱼入口已隐藏');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    elements.saveSiteSettingsButton.disabled = false;
  }
});

syncUploadTarget();
initializeAnalyticsRange();
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
    await uploadBinary(task.uploadUrl, file, elements.uploadProgressBar, elements.uploadProgressText);
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

elements.resourcePackForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = elements.resourcePackFile.files[0];
  if (!file) return;
  elements.resourcePackUploadButton.disabled = true;
  elements.resourcePackProgress.hidden = false;
  elements.resourcePackProgressBar.value = 0;
  elements.resourcePackProgressText.textContent = '0%';
  try {
    const task = await api('/api/admin/resource-packs', {
      method: 'POST',
      body: {
        category: elements.resourcePackCategory.value,
        title: elements.resourcePackTitle.value.trim(),
        description: elements.resourcePackDescription.value.trim(),
        fileName: file.name,
        fileSize: file.size
      }
    });
    await uploadBinary(
      task.uploadUrl,
      file,
      elements.resourcePackProgressBar,
      elements.resourcePackProgressText
    );
    elements.resourcePackProgressBar.value = 100;
    elements.resourcePackProgressText.textContent = '100%';
    elements.resourcePackForm.reset();
    showToast('资源包已上传并公开');
    await loadResourcePacks();
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    elements.resourcePackUploadButton.disabled = false;
    window.setTimeout(() => {
      elements.resourcePackProgress.hidden = true;
    }, 800);
  }
});

elements.refreshButton.addEventListener('click', loadReleases);
elements.refreshResourcePacksButton.addEventListener('click', loadResourcePacks);
elements.refreshActivationButton.addEventListener('click', loadActivations);
elements.refreshInteractionButton.addEventListener('click', loadInteractions);
elements.refreshCompanionButton.addEventListener('click', loadCompanions);
elements.analyticsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await loadAnalytics();
});
elements.refreshContentButton.addEventListener('click', loadContent);
elements.refreshFeedbackButton.addEventListener('click', loadFeedback);
elements.contentSelectVisible.addEventListener('change', () => {
  for (const id of visibleActiveContentIds) {
    if (elements.contentSelectVisible.checked) selectedContentIds.add(id);
    else selectedContentIds.delete(id);
  }
  listViews.content.refresh();
});
elements.clearContentSelectionButton.addEventListener('click', () => {
  selectedContentIds.clear();
  listViews.content.refresh();
});
elements.disableSelectedContentButton.addEventListener('click', disableSelectedContent);
elements.contentBulkType.addEventListener('change', updateContentBulkControls);
elements.disableContentTypeButton.addEventListener('click', disableContentType);
elements.contentTypeFilter.addEventListener('change', () => {
  if (elements.contentTypeFilter.value) {
    elements.contentBulkType.value = elements.contentTypeFilter.value;
  }
  updateContentBulkControls();
});

elements.contentEditorForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  elements.saveContentButton.disabled = true;
  try {
    const payload = contentFormPayload();
    const editing = Boolean(editingContentId);
    await api(
      editing
        ? `/api/admin/content/${encodeURIComponent(editingContentId)}`
        : '/api/admin/content',
      { method: editing ? 'PATCH' : 'POST', body: payload }
    );
    showToast(editing ? '内容已更新' : '内容已新增');
    resetContentEditor();
    await loadContent();
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    elements.saveContentButton.disabled = false;
  }
});

elements.cancelContentEditButton.addEventListener('click', resetContentEditor);

elements.contentImportForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = elements.contentImportFile.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    showToast('导入文件不能超过 2 MB', 'error');
    return;
  }
  if (elements.contentDisableMissing.checked) {
    const confirmed = await confirmAction({
      title: '导入并停用缺失内容',
      message: '现有内容中未出现在本次文件里的条目会被停用。',
      confirmLabel: '确认导入',
      danger: true
    });
    if (!confirmed) return;
  }
  elements.importContentButton.disabled = true;
  try {
    const parsed = JSON.parse(await file.text());
    const items = Array.isArray(parsed) ? parsed : parsed?.items;
    const result = await api('/api/admin/content/import', {
      method: 'POST',
      body: {
        items,
        disableMissing: elements.contentDisableMissing.checked
      }
    });
    showToast(`导入完成：新增 ${result.created}，更新 ${result.updated}，跳过 ${result.skipped}，停用 ${result.disabled}`);
    elements.contentImportForm.reset();
    resetContentEditor();
    await loadContent();
  } catch (error) {
    showToast(error instanceof SyntaxError ? 'JSON 文件格式无效' : error.message, 'error');
  } finally {
    elements.importContentButton.disabled = false;
  }
});

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

elements.copyAdminUrlButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(elements.adminUrl.value);
    showToast('管理后台地址已复制');
  } catch {
    elements.adminUrl.select();
    showToast('已选中管理后台地址');
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
