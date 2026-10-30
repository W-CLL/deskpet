registerAdminPage(function createResourcePacksPage({ ui, api, showToast, confirmAction }) {
  const {
    byId, setText, bindClick, bindSubmit, formatBytes, formatDate, cell, actionButton, stackedCell,
    hashCell, actionsCell, fillTable, createListView, loadJson, submitUpload
  } = ui;
  let editingPack = null;
  const statusLabels = { draft: '草稿', published: '已上架', unlisted: '已下架' };

  function categoryLabel(category) {
    return category === 'theater-scripts' ? '小剧场剧本' : '互动词包';
  }

  function drawerSubmitButton() {
    return document.querySelector('#editorDrawer .drawer-footer-actions .button-primary');
  }

  function openUploadDrawer(pack = null) {
    const form = byId('resourcePackForm');
    editingPack = pack;
    form.reset();
    byId('resourcePackCategory').value = pack?.category || 'interaction-words';
    byId('resourcePackTitle').value = pack?.title || '';
    byId('resourcePackDescription').value = pack?.description || '';
    byId('resourcePackVersion').value = pack?.version || '1.0.0';
    byId('resourcePackVersion').readOnly = Boolean(pack);
    byId('resourcePackStatus').value = pack?.status || 'published';
    byId('resourcePackFile').required = !pack;
    byId('resourcePackFile').closest('label').hidden = Boolean(pack);
    byId('resourcePackFormError').textContent = pack?.validationError || '';
    globalThis.AdminFormKit.openFormDrawer({
      form,
      title: pack ? '编辑资源包' : '上传资源包',
      eyebrow: '资源包',
      submitLabel: pack ? '保存资源包设置' : '上传并校验',
      onCancel: () => form.reset(),
      focusSelector: '#resourcePackTitle'
    });
  }

  async function togglePublished(pack) {
    try {
      await api(`/api/admin/resource-packs/${encodeURIComponent(pack.id)}`, {
        method: 'PATCH', body: { status: pack.status === 'published' ? 'unlisted' : 'published' }
      });
      showToast(pack.status === 'published' ? '资源包已下架' : '资源包已上架');
      await loadResourcePacks();
    } catch (error) { showToast(error.message, 'error'); }
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
          stackedCell('', categoryLabel(pack.category), statusLabels[pack.status] || '已上架',
            pack.installable === false ? `无法安装：${pack.validationError || '请重新上传有效资源包'}` : `${pack.fileCount || 0} 个内容 · 免费`),
          stackedCell('file-cell', pack.originalName, `版本 ${pack.version || '1.0.0'} · ${formatBytes(pack.size)}`),
          hashCell(pack.sha256),
          cell('', formatDate(pack.createdAt)),
          actionsCell(...(pack.status === 'published' && pack.installable !== false ? [download] : []),
            actionButton('编辑', 'button-secondary', () => openUploadDrawer(pack)),
            actionButton(pack.status === 'published' ? '下架' : '上架', 'button-secondary', () => togglePublished(pack)),
            actionButton('删除', 'button-danger', () => deleteResourcePack(pack)))
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

  bindSubmit('resourcePackForm', async () => {
    if (editingPack) {
      const button = drawerSubmitButton();
      if (button) button.disabled = true;
      byId('resourcePackFormError').textContent = '';
      try {
        await api(`/api/admin/resource-packs/${encodeURIComponent(editingPack.id)}`, { method: 'PATCH', body: {
          title: byId('resourcePackTitle').value.trim(), description: byId('resourcePackDescription').value.trim(),
          category: byId('resourcePackCategory').value, status: byId('resourcePackStatus').value
        } });
        globalThis.AdminFormKit.closeDrawer();
        showToast('资源包设置已保存');
        await loadResourcePacks();
      } catch (error) { byId('resourcePackFormError').textContent = error.message; }
      finally { if (button) button.disabled = false; }
      return;
    }
    await submitUpload({
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
      description: byId('resourcePackDescription').value.trim(),
      status: byId('resourcePackStatus').value,
      version: byId('resourcePackVersion').value.trim()
    }),
    afterReset: () => {
      byId('resourcePackForm').hidden = true;
      globalThis.AdminFormKit?.closeDrawer();
    },
    reload: loadResourcePacks,
    successText: '资源包已通过校验并保存'
    });
  });
  bindClick('refreshResourcePacksButton', loadResourcePacks);
  bindClick('createResourcePackButton', () => openUploadDrawer());

  return { id: 'resource-packs', load: loadResourcePacks };
});
