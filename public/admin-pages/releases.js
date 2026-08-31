registerAdminPage(function createReleasesPage({ ui, api, showToast, confirmAction, navigateTo }) {
  const {
    byId, setText, bindClick, bindSubmit, formatBytes, formatDate, cell, actionButton,
    stackedCell, badgeCell, hashCell, actionsCell, fillTable, createListView, loadJson, submitUpload
  } = ui;

  const platformInputs = document.querySelectorAll('input[name="platform"]');

  function releaseStatusKey(release) {
    if (release.active) return 'active';
    return release.publishedAt ? 'published' : 'draft';
  }

  function releaseApiPath(release) {
    return `/api/admin/releases/${encodeURIComponent(release.platform)}/${encodeURIComponent(release.architecture)}/${encodeURIComponent(release.version)}`;
  }

  function platformLabel(release) {
    const system = { windows: 'Windows', macos: 'macOS', android: 'Android' }[release.platform]
      || release.platform;
    return `${system} / ${release.architecture}`;
  }

  function selectedReleasePlatform() {
    return Array.from(platformInputs).find((input) => input.checked)?.value || 'windows';
  }

  function syncUploadTarget() {
    const platform = selectedReleasePlatform();
    const choices = {
      windows: [['x64', 'x64']],
      macos: [['arm64', 'Apple Silicon'], ['x86_64', 'Intel']],
      android: [['arm64-v8a', 'ARM64（推荐）'], ['armeabi-v7a', 'ARMv7（32 位）']]
    }[platform];
    const architecture = byId('releaseArchitecture');
    const previous = architecture.value;
    architecture.replaceChildren(...choices.map(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      return option;
    }));
    if (choices.some(([value]) => value === previous)) architecture.value = previous;
    byId('releaseFile').value = '';
    const fileConfig = {
      windows: ['.exe,application/octet-stream', 'Windows 安装包 EXE'],
      macos: ['.zip,application/zip,application/octet-stream', 'macOS 更新包 ZIP'],
      android: ['.apk,application/vnd.android.package-archive,application/octet-stream', 'Android 安装包 APK']
    }[platform];
    [byId('releaseFile').accept, byId('releaseFileLabel').textContent] = fileConfig;
  }

  function renderAndroidReleaseTarget(payload, architecture, versionId, statusId) {
    const versionElement = byId(versionId);
    const statusElement = byId(statusId);
    if (!versionElement || !statusElement) return;
    const activeVersion = payload.activeVersions?.[`android/${architecture}`];
    versionElement.textContent = activeVersion ? `v${activeVersion}` : '未发布';
    statusElement.textContent = activeVersion ? `当前 v${activeVersion}` : '未发布';
    statusElement.className = `status-badge${activeVersion ? ' active' : ''}`;
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

  const listView = createListView('releases', {
    emptyElement: byId('emptyReleases'),
    renderPage(releases) {
      fillTable(byId('releaseRows'), releases, (release) => {
        const statusClass = release.public ? 'active' : release.active ? 'published' : release.publishedAt ? 'published' : 'draft';
        const statusText = release.public ? '官网公开' : release.active ? '当前发布' : release.publishedAt ? '已发布' : '草稿';
        return [
          stackedCell('version-cell', `v${release.version}`, release.notes ? release.notes.split('\n')[0] : '无更新说明'),
          cell('', platformLabel(release)),
          badgeCell(statusText, statusClass),
          stackedCell('file-cell', release.fileName, formatBytes(release.size)),
          hashCell(release.sha256),
          cell('', formatDate(release.createdAt)),
          actionsCell(
            !release.active && actionButton('发布', 'button-secondary', () => publishRelease(release)),
            !release.active && actionButton('删除', 'button-danger', () => deleteRelease(release))
          )
        ];
      });
    },
    matches: (item, filters) => (!filters.platform || item.platform === filters.platform)
      && (!filters.status || releaseStatusKey(item) === filters.status)
  });

  function renderReleases(payload) {
    const activeEntries = Object.entries(payload.activeVersions || {});
    setText('activeVersion', activeEntries.length ? String(activeEntries.length) : '尚未发布');
    setText('overviewReleaseTotal', payload.releases.length);
    setText('releasePageTotal', payload.releases.length);
    setText('releasePagePublished', payload.releases.filter((release) => release.publishedAt).length);
    const draftCount = payload.releases.filter((release) => !release.publishedAt).length;
    setText('releasePageDrafts', draftCount);
    const todoDrafts = byId('overviewTodoDrafts');
    if (todoDrafts) {
      todoDrafts.textContent = draftCount > 0
        ? `还有 ${draftCount} 个草稿待发布`
        : '当前没有待发布草稿';
    }
    byId('adminUrl').value = payload.adminUrl || '';
    byId('manifestUrl').value = payload.manifestUrl || '';
    setText('androidReleaseTotal', payload.releases.filter((release) => release.platform === 'android').length);
    renderAndroidReleaseTarget(payload, 'arm64-v8a', 'androidArm64Version', 'androidArm64Status');
    renderAndroidReleaseTarget(payload, 'armeabi-v7a', 'androidArmv7Version', 'androidArmv7Status');
    listView.setItems(payload.releases);
  }

  async function loadReleases() {
    await loadJson('/api/admin/releases', renderReleases, byId('refreshButton'));
  }

  syncUploadTarget();
  for (const input of platformInputs) {
    input.addEventListener('change', syncUploadTarget);
  }

  bindClick('manageAndroidReleasesButton', () => {
    const androidInput = Array.from(platformInputs).find((input) => input.value === 'android');
    if (androidInput) androidInput.checked = true;
    syncUploadTarget();
    navigateTo('releases');
    byId('releaseVersion').focus();
  });

  bindSubmit('uploadForm', () => submitUpload({
    form: byId('uploadForm'),
    fileInput: byId('releaseFile'),
    button: byId('uploadButton'),
    progress: byId('uploadProgress'),
    progressBar: byId('uploadProgressBar'),
    progressText: byId('uploadProgressText'),
    createPath: '/api/admin/releases',
    body: () => ({
      platform: selectedReleasePlatform(),
      architecture: byId('releaseArchitecture').value,
      version: byId('releaseVersion').value.trim(),
      notes: byId('releaseNotes').value.trim()
    }),
    afterReset: syncUploadTarget,
    reload: loadReleases,
    successText: '安装包已上传为草稿'
  }));

  bindClick('refreshButton', loadReleases);

  return { load: loadReleases };
});
