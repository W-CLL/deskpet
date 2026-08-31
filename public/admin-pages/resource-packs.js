registerAdminPage(function createResourcePacksPage({ ui, api, showToast, confirmAction }) {
  const {
    byId, bindClick, bindSubmit, formatBytes, formatDate, cell, actionButton, stackedCell,
    hashCell, actionsCell, fillTable, createListView, loadJson, submitUpload
  } = ui;

  function categoryLabel(category) {
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
    matches: (item, filters) => !filters.category || item.category === filters.category
  });

  async function loadResourcePacks() {
    await loadJson('/api/admin/resource-packs', (payload) => {
      listView.setItems(payload.packs);
    }, byId('refreshResourcePacksButton'));
  }

  bindSubmit('resourcePackForm', () => submitUpload({
    form: byId('resourcePackForm'),
    fileInput: byId('resourcePackFile'),
    button: byId('resourcePackUploadButton'),
    progress: byId('resourcePackProgress'),
    progressBar: byId('resourcePackProgressBar'),
    progressText: byId('resourcePackProgressText'),
    createPath: '/api/admin/resource-packs',
    body: () => ({
      category: byId('resourcePackCategory').value,
      title: byId('resourcePackTitle').value.trim(),
      description: byId('resourcePackDescription').value.trim()
    }),
    reload: loadResourcePacks,
    successText: '资源包已上传并公开'
  }));
  bindClick('refreshResourcePacksButton', loadResourcePacks);

  return { load: loadResourcePacks };
});
