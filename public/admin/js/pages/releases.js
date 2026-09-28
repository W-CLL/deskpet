registerAdminPage(function createReleasesPage({ ui, api, showToast, confirmAction, navigateTo }) {
  const {
    byId, setText, bindClick, bindSubmit, formatBytes, formatDate, cell, actionButton,
    stackedCell, badgeCell, hashCell, actionsCell, fillTable, createListView, loadJson, submitUpload
  } = ui;

  const platformInputs = () => document.querySelectorAll('input[name="platform"]');
  const uploadForm = byId('uploadForm');
  const notesForm = byId('releaseNotesEditorForm');
  const releaseFormsHost = uploadForm.parentElement;
  const notesInput = byId('releaseNotesEditorText');
  const notesPreview = byId('releaseNotesEditorPreview');
  const notesCount = byId('releaseNotesEditorCount');
  const notesError = byId('releaseNotesEditorError');
  let notesEditor = null;
  let notesDrawerButtons = null;
  let notesSaving = false;

  // The shared drawer moves forms into its body. Keep both release forms
  // reachable when another drawer replaces that body.
  function parkReleaseForms() {
    for (const form of [uploadForm, notesForm]) {
      form.hidden = true;
      if (form.parentElement !== releaseFormsHost) releaseFormsHost.append(form);
    }
  }

  function updateNotesPreview() {
    notesCount.textContent = `${notesInput.value.length} / 1200 字符`;
    notesPreview.value = notesInput.value;
    notesInput.setCustomValidity(notesInput.value.length > 1200 ? '更新说明最多 1200 字符。' : '');
    if (notesDrawerButtons) {
      notesDrawerButtons.save.disabled = notesSaving || Boolean(notesEditor?.conflicted)
        || notesInput.value.length > 1200;
    }
  }

  function openNotesDrawer(release) {
    if (notesSaving) return;
    parkReleaseForms();
    notesEditor = { ...release, expectedNotes: release.notes || '', conflicted: false };
    notesInput.value = notesEditor.expectedNotes;
    notesError.textContent = '';
    setText('releaseNotesEditorTarget', `${platformLabel(release)} · v${release.version}`);
    notesForm.querySelector('details').open = false;
    notesDrawerButtons = globalThis.AdminFormKit.openFormDrawer({
      form: notesForm,
      title: '编辑更新说明',
      eyebrow: '版本发布',
      submitLabel: '保存说明',
      focusSelector: '#releaseNotesEditorText'
    });
    updateNotesPreview();
  }

  async function saveReleaseNotes() {
    if (notesSaving || !notesEditor || notesEditor.conflicted) return;
    updateNotesPreview();
    if (!notesForm.reportValidity()) return;
    const editing = notesEditor;
    const buttons = notesDrawerButtons;
    const notes = notesInput.value;
    notesSaving = true;
    notesInput.readOnly = true;
    notesForm.setAttribute('aria-busy', 'true');
    notesError.textContent = '';
    buttons.save.disabled = true;
    buttons.save.textContent = '保存中…';
    try {
      await api(`${releaseApiPath(editing)}/notes`, {
        method: 'PATCH',
        body: { notes, expectedNotes: editing.expectedNotes }
      });
      showToast(`${platformLabel(editing)} v${editing.version} 更新说明已保存`);
      if (byId('drawerBody').contains(notesForm)) globalThis.AdminFormKit.closeDrawer();
      notesForm.hidden = true;
      if (notesEditor === editing) notesEditor = null;
      await loadReleases();
    } catch (error) {
      if (error.status === 409 && error.code === 'RELEASE_NOTES_CONFLICT') {
        editing.conflicted = true;
        notesError.textContent = '说明已被其他人修改，当前输入已保留。请先复制需要保留的内容，关闭后刷新版本列表，再重新打开编辑。';
      } else {
        notesError.textContent = error.message || '保存失败，当前输入已保留，请稍后重试。';
      }
    } finally {
      notesSaving = false;
      notesInput.readOnly = false;
      notesForm.removeAttribute('aria-busy');
      buttons.save.textContent = '保存说明';
      updateNotesPreview();
    }
  }

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
    return Array.from(platformInputs()).find((input) => input.checked)?.value || 'windows';
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

  function resetUploadForm(presetPlatform) {
    byId('uploadForm').reset();
    const target = presetPlatform || 'windows';
    const input = Array.from(platformInputs()).find((item) => item.value === target);
    if (input) input.checked = true;
    syncUploadTarget();
  }

  function openReleaseDrawer(presetPlatform) {
    if (notesSaving) return;
    parkReleaseForms();
    resetUploadForm(presetPlatform);
    globalThis.AdminFormKit.openFormDrawer({
      form: byId('uploadForm'),
      title: '创建发布草稿',
      eyebrow: '版本发布',
      submitLabel: '上传为草稿',
      onCancel: () => resetUploadForm('windows'),
      focusSelector: '#releaseVersion'
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
            actionButton('编辑说明', 'button-secondary', () => openNotesDrawer(release)),
            !release.active && actionButton('发布', 'button-secondary', () => publishRelease(release)),
            !release.active && actionButton('删除', 'button-danger', () => deleteRelease(release))
          )
        ];
      });
    },
    matches: (item, filters) => (!filters.platform || item.platform === filters.platform)
      && (!filters.status || releaseStatusKey(item) === filters.status),
    searchPlaceholder: '搜索版本、文件名或说明',
    searchText: (item) => [item.version, item.fileName, item.notes, item.platform, item.architecture, item.sha256]
  });

  function renderReleases(payload) {
    const activeEntries = Object.entries(payload.activeVersions || {});
    setText('activeVersion', activeEntries.length ? String(activeEntries.length) : '0');
    setText('releasePageTotal', payload.releases.length);
    setText('releasePagePublished', payload.releases.filter((release) => release.publishedAt).length);
    setText('releasePageDrafts', payload.releases.filter((release) => !release.publishedAt).length);

    const adminUrl = byId('adminUrl');
    const manifestUrl = byId('manifestUrl');
    if (adminUrl) adminUrl.value = payload.adminUrl || '';
    if (manifestUrl) manifestUrl.value = payload.manifestUrl || '';
    setText('androidReleaseTotal', payload.releases.filter((release) => release.platform === 'android').length);
    renderAndroidReleaseTarget(payload, 'arm64-v8a', 'androidArm64Version', 'androidArm64Status');
    renderAndroidReleaseTarget(payload, 'armeabi-v7a', 'androidArmv7Version', 'androidArmv7Status');
    listView.setItems(payload.releases);
  }

  async function loadReleases() {
    await loadJson('/api/admin/releases', renderReleases, byId('refreshButton'));
  }

  syncUploadTarget();
  for (const input of platformInputs()) {
    input.addEventListener('change', syncUploadTarget);
  }

  bindClick('manageAndroidReleasesButton', () => {
    navigateTo('releases');
    openReleaseDrawer('android');
  });
  bindClick('manageAndroidDevicesButton', () => navigateTo('android/devices'));
  bindClick('createReleaseButton', () => openReleaseDrawer());
  notesInput.addEventListener('input', updateNotesPreview);
  bindSubmit('releaseNotesEditorForm', saveReleaseNotes);

  bindSubmit('uploadForm', () => submitUpload({
    form: byId('uploadForm'),
    fileInput: byId('releaseFile'),
    button: document.querySelector('#editorDrawer .drawer-footer-actions .button-primary'),
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
    afterReset: () => {
      resetUploadForm('windows');
      byId('uploadForm').hidden = true;
      if (byId('drawerBody').contains(uploadForm)) globalThis.AdminFormKit?.closeDrawer();
    },
    reload: loadReleases,
    successText: '安装包已上传为草稿'
  }));

  bindClick('refreshButton', loadReleases);

  return { id: 'releases', load: loadReleases };
});
