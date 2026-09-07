registerAdminPage(function createResourcePacksPage({ ui, api, showToast, confirmAction }) {
  const {
    byId, setText, bindClick, bindSubmit, formatBytes, formatDate, cell, actionButton, stackedCell,
    hashCell, actionsCell, fillTable, createListView, loadJson, submitUpload
  } = ui;

  function categoryLabel(category) {
    return category === 'theater-scripts' ? '小剧场剧本' : '互动词包';
  }

  function drawerSubmitButton() {
    return document.querySelector('#editorDrawer .drawer-footer-actions .button-primary');
  }

  function openUploadDrawer() {
    const form = byId('resourcePackForm');
    globalThis.AdminFormKit.openFormDrawer({
      form,
      title: '上传资源包',
      eyebrow: '资源包',
      submitLabel: '上传并公开',
      onCancel: () => form.reset(),
      focusSelector: '#resourcePackTitle'
    });
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

  const listView = createListView('resource-packs', {
    emptyElement: byId('emptyResourcePacks'),
    renderPage(packs) {
      fillTable(byId('resourcePackRows'), packs, (pack) => {
        const download = document.createElement('a');
        download.className = 'button button-secondary';
        download.href = pack.url;
        download.textContent = '下载';
        return [
          stackedCell('version-cell', pack.title, pack.description),
          cell('', categoryLabel(pack.category)),
          stackedCell('file-cell', pack.originalName, formatBytes(pack.size)),
          hashCell(pack.sha256),
          cell('', formatDate(pack.createdAt)),
          actionsCell(download, actionButton('删除', 'button-danger', () => deleteResourcePack(pack)))
        ];
      });
    },
    matches: (item, filters) => !filters.category || item.category === filters.category,
    searchPlaceholder: '搜索标题、简介或文件名',
    searchText: (item) => [item.title, item.description, item.originalName, item.category, categoryLabel(item.category)]
  });

  async function loadResourcePacks() {
    await loadJson('/api/admin/resource-packs', (payload) => {
      const packs = payload.packs || [];
      const words = packs.filter((item) => item.category === 'interaction-words');
      const theater = packs.filter((item) => item.category === 'theater-scripts');
      const bytes = packs.reduce((sum, item) => sum + Number(item.size || 0), 0);
      setText('resourcePackTotal', packs.length);
      setText('resourcePackWords', words.length);
      setText('resourcePackTheater', theater.length);
      setText('resourcePackBytes', formatBytes(bytes));
      listView.setItems(packs);
    }, byId('refreshResourcePacksButton'));
  }

  bindSubmit('resourcePackForm', () => submitUpload({
    form: byId('resourcePackForm'),
    fileInput: byId('resourcePackFile'),
    button: drawerSubmitButton(),
    progress: byId('resourcePackProgress'),
    progressBar: byId('resourcePackProgressBar'),
    progressText: byId('resourcePackProgressText'),
    createPath: '/api/admin/resource-packs',
    body: () => ({
      category: byId('resourcePackCategory').value,
      title: byId('resourcePackTitle').value.trim(),
      description: byId('resourcePackDescription').value.trim()
    }),
    afterReset: () => {
      byId('resourcePackForm').hidden = true;
      globalThis.AdminFormKit?.closeDrawer();
    },
    reload: loadResourcePacks,
    successText: '资源包已上传并公开'
  }));
  bindClick('refreshResourcePacksButton', loadResourcePacks);
  bindClick('createResourcePackButton', openUploadDrawer);

  return { id: 'resource-packs', load: loadResourcePacks };
});
