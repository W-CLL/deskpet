registerAdminPage(function createVisitStickersPage({ ui, api, showToast, confirmAction }) {
  const {
    byId, setText, bindClick, bindSubmit, formatDate, cell, actionButton, stackedCell,
    actionsCell, fillTable, createListView, loadJson, submitUpload
  } = ui;

  function categoryLabel(category) {
    return { girlfriend: '女友', friend: '好友', companion: '搭子' }[category] || category;
  }

  async function deleteVisitStickerPack(pack) {
    const confirmed = await confirmAction({
      title: `删除“${pack.title}”`,
      message: `会删掉这个压缩包里的 ${pack.stickerCount} 张体验来访表情。`,
      confirmLabel: '删除表情包',
      danger: true
    });
    if (!confirmed) return;
    try {
      await api(`/api/admin/visit-stickers/packs/${encodeURIComponent(pack.id)}`, { method: 'DELETE' });
      showToast('体验来访表情包已删除');
      await loadVisitStickers();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  const listView = createListView('visit-stickers', {
    emptyElement: byId('emptyVisitStickers'),
    renderPage(packs) {
      fillTable(byId('visitStickerRows'), packs, (pack) => [
        stackedCell('version-cell', pack.title, pack.note || pack.originalName || ''),
        cell('', categoryLabel(pack.category)),
        cell('', `${pack.stickerCount} 张`),
        cell('', formatDate(pack.createdAt)),
        actionsCell(actionButton('删除', 'button-danger', () => deleteVisitStickerPack(pack)))
      ]);
    },
    matches: (item, filters) => !filters.category || item.category === filters.category
  });

  function renderVisitStickers(payload) {
    setText('visitStickerGirlfriendCount', String(payload.counts?.girlfriend || 0));
    setText('visitStickerFriendCount', String(payload.counts?.friend || 0));
    setText('visitStickerCompanionCount', String(payload.counts?.companion || 0));
    listView.setItems(payload.packs || []);
  }

  async function loadVisitStickers() {
    await loadJson('/api/admin/visit-stickers', renderVisitStickers, byId('refreshVisitStickersButton'));
  }

  bindSubmit('visitStickerForm', () => submitUpload({
    form: byId('visitStickerForm'),
    fileInput: byId('visitStickerFile'),
    button: byId('visitStickerUploadButton'),
    progress: byId('visitStickerProgress'),
    progressBar: byId('visitStickerProgressBar'),
    progressText: byId('visitStickerProgressText'),
    createPath: '/api/admin/visit-stickers',
    body: () => ({
      category: byId('visitStickerCategory').value,
      title: byId('visitStickerTitle').value.trim(),
      note: byId('visitStickerNote').value.trim()
    }),
    reload: loadVisitStickers,
    successText: '体验来访表情已上传'
  }));
  bindClick('refreshVisitStickersButton', loadVisitStickers);

  return { load: loadVisitStickers };
});
