registerAdminPage(function createContentPage({ ui, api, showToast, confirmAction }) {
  const {
    byId, setText, bindClick, bindSubmit, formatDate, cell, actionButton, stackedCell,
    statusBadge, actionsCell, fillTable, createListView, loadJson, withBusy
  } = ui;

  const typeLabels = {
    joke: '冷笑话',
    math: '数学题',
    trivia: '趣味知识',
    riddle: '脑筋急转弯',
    tip: '生活小贴士',
    care: '关怀内容'
  };

  let editingContentId = '';
  let contentItems = [];
  let visibleActiveContentIds = [];
  let contentBulkPending = false;
  const selectedContentIds = new Set();

  function resetContentEditor() {
    editingContentId = '';
    byId('contentEditorForm').reset();
    byId('contentType').value = 'joke';
    byId('contentDifficulty').value = '1';
    byId('contentLocale').value = 'zh-CN';
    byId('contentActiveInput').checked = true;
    byId('contentId').readOnly = false;
    setText('contentEditorTitle', '新增内容');
    setText('contentEditorState', '新内容');
    byId('cancelContentEditButton').hidden = true;
    byId('saveContentButton').textContent = '新增内容';
  }

  function editContent(item) {
    editingContentId = item.id;
    byId('contentType').value = item.type;
    byId('contentId').value = item.id;
    byId('contentId').readOnly = true;
    byId('contentDifficulty').value = String(item.difficulty);
    byId('contentLocale').value = item.locale;
    byId('contentPrompt').value = item.prompt;
    byId('contentAnswer').value = item.answer;
    byId('contentExplanation').value = item.explanation || '';
    byId('contentChoices').value = item.choices.join('\n');
    byId('contentTags').value = item.tags.join('，');
    byId('contentActiveInput').checked = item.active;
    setText('contentEditorTitle', '编辑内容');
    setText('contentEditorState', `修订版 ${item.revision}`);
    byId('cancelContentEditButton').hidden = false;
    byId('saveContentButton').textContent = '保存修改';
    byId('contentEditorForm').scrollIntoView({ block: 'start', behavior: 'smooth' });
    byId('contentPrompt').focus({ preventScroll: true });
  }

  function contentFormPayload() {
    const choices = byId('contentChoices').value.split('\n').map((value) => value.trim()).filter(Boolean);
    const tags = byId('contentTags').value.split(/[,，\n]/).map((value) => value.trim()).filter(Boolean);
    return {
      ...(byId('contentId').value.trim() ? { id: byId('contentId').value.trim() } : {}),
      type: byId('contentType').value,
      prompt: byId('contentPrompt').value.trim(),
      answer: byId('contentAnswer').value.trim(),
      explanation: byId('contentExplanation').value.trim(),
      choices,
      tags,
      difficulty: Number(byId('contentDifficulty').value),
      locale: byId('contentLocale').value.trim(),
      active: byId('contentActiveInput').checked
    };
  }

  function selectedActiveContentIds() {
    const activeIds = new Set(contentItems.filter((item) => item.active).map((item) => item.id));
    return [...selectedContentIds].filter((id) => activeIds.has(id));
  }

  function updateContentBulkControls() {
    const selectedIds = selectedActiveContentIds();
    const selectedVisible = visibleActiveContentIds.filter((id) => selectedContentIds.has(id));
    const type = byId('contentBulkType').value;
    const activeTypeCount = type
      ? contentItems.filter((item) => item.active && item.type === type).length
      : 0;

    setText('contentSelectionCount', `已选 ${selectedIds.length} 条`);
    byId('clearContentSelectionButton').disabled = contentBulkPending || selectedIds.length === 0;
    byId('disableSelectedContentButton').disabled = contentBulkPending
      || selectedIds.length === 0
      || selectedIds.length > 500;
    byId('disableSelectedContentButton').title = selectedIds.length > 500
      ? '单次最多批量禁用 500 条内容'
      : '';
    byId('disableContentTypeButton').disabled = contentBulkPending || !type || activeTypeCount === 0;
    byId('disableContentTypeButton').textContent = activeTypeCount
      ? `禁用该类型 (${activeTypeCount})`
      : '禁用该类型';
    byId('contentSelectVisible').disabled = contentBulkPending || visibleActiveContentIds.length === 0;
    byId('contentSelectVisible').checked = visibleActiveContentIds.length > 0
      && selectedVisible.length === visibleActiveContentIds.length;
    byId('contentSelectVisible').indeterminate = selectedVisible.length > 0
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
    const type = byId('contentBulkType').value;
    if (!type) return;
    const activeCount = contentItems.filter((item) => item.active && item.type === type).length;
    if (!activeCount) return;
    const typeLabel = typeLabels[type] || type;
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

  const listView = createListView('content', {
    emptyElement: byId('emptyContent'),
    renderPage(items) {
      visibleActiveContentIds = items.filter((item) => item.active).map((item) => item.id);
      fillTable(byId('contentRows'), items, (item) => {
        const row = document.createElement('tr');
        if (!item.active) row.className = 'content-disabled-row';

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
        const selectionCell = cell('content-selection-cell');
        selectionCell.append(selection);

        const id = document.createElement('code');
        id.textContent = item.id;
        row.append(
          selectionCell,
          stackedCell(
            'content-type-cell',
            typeLabels[item.type] || item.type,
            statusBadge(item.active ? '启用' : '停用', item.active ? 'active' : 'revoked'),
            id
          ),
          stackedCell('content-copy-cell', item.prompt, `答案：${item.answer}`, item.explanation || '无解释'),
          stackedCell(
            'content-meta-cell',
            `难度 ${item.difficulty} · ${item.locale}`,
            item.tags.length ? item.tags.join(' · ') : '无标签',
            item.choices.length ? `${item.choices.length} 个选项` : '无选项'
          ),
          stackedCell('date-stack', `修订版 ${item.revision}`, formatDate(item.updatedAt)),
          actionsCell(
            actionButton('编辑', 'button-secondary', () => editContent(item)),
            actionButton(
              item.active ? '停用' : '启用',
              item.active ? 'button-danger' : 'button-secondary',
              () => setContentActive(item, !item.active)
            )
          )
        );
        return row;
      });
      updateContentBulkControls();
    },
    matches: (item, filters) => (!filters.type || item.type === filters.type)
      && (!filters.active || (item.active ? 'active' : 'disabled') === filters.active)
  });

  function renderContent(payload) {
    const summary = payload.summary || {};
    contentItems = Array.isArray(payload.items) ? payload.items : [];
    const activeIds = new Set(contentItems.filter((item) => item.active).map((item) => item.id));
    for (const id of selectedContentIds) {
      if (!activeIds.has(id)) selectedContentIds.delete(id);
    }
    setText('contentCatalogVersion', payload.catalog?.version || 0);
    setText('contentActive', summary.active || 0);
    setText('contentJokes', summary.jokes || 0);
    setText('contentMath', summary.math || 0);
    setText('contentTrivia', summary.trivia || 0);
    setText('contentRiddles', summary.riddles || 0);
    setText('contentTips', summary.tips || 0);
    setText('contentCare', summary.care || 0);
    setText('contentDisabled', summary.disabled || 0);
    listView.setItems(contentItems);
    updateContentBulkControls();
  }

  async function loadContent() {
    await loadJson('/api/admin/content', renderContent, byId('refreshContentButton'));
  }

  bindClick('refreshContentButton', loadContent);
  byId('contentSelectVisible').addEventListener('change', () => {
    for (const id of visibleActiveContentIds) {
      if (byId('contentSelectVisible').checked) selectedContentIds.add(id);
      else selectedContentIds.delete(id);
    }
    listView.refresh();
  });
  bindClick('clearContentSelectionButton', () => {
    selectedContentIds.clear();
    listView.refresh();
  });
  bindClick('disableSelectedContentButton', disableSelectedContent);
  byId('contentBulkType').addEventListener('change', updateContentBulkControls);
  bindClick('disableContentTypeButton', disableContentType);
  byId('contentTypeFilter').addEventListener('change', () => {
    if (byId('contentTypeFilter').value) {
      byId('contentBulkType').value = byId('contentTypeFilter').value;
    }
    updateContentBulkControls();
  });

  bindSubmit('contentEditorForm', async () => {
    await withBusy(byId('saveContentButton'), async () => {
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
    });
  });
  bindClick('cancelContentEditButton', resetContentEditor);

  bindSubmit('contentImportForm', async () => {
    const file = byId('contentImportFile').files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      showToast('导入文件不能超过 2 MB', 'error');
      return;
    }
    if (byId('contentDisableMissing').checked) {
      const confirmed = await confirmAction({
        title: '导入并停用缺失内容',
        message: '现有内容中未出现在本次文件里的条目会被停用。',
        confirmLabel: '确认导入',
        danger: true
      });
      if (!confirmed) return;
    }
    await withBusy(byId('importContentButton'), async () => {
      const parsed = JSON.parse(await file.text());
      const items = Array.isArray(parsed) ? parsed : parsed?.items;
      const result = await api('/api/admin/content/import', {
        method: 'POST',
        body: {
          items,
          disableMissing: byId('contentDisableMissing').checked
        }
      });
      showToast(`导入完成：新增 ${result.created}，更新 ${result.updated}，跳过 ${result.skipped}，停用 ${result.disabled}`);
      byId('contentImportForm').reset();
      resetContentEditor();
      await loadContent();
    }, (error) => {
      showToast(error instanceof SyntaxError ? 'JSON 文件格式无效' : error.message, 'error');
    });
  });

  return { load: loadContent };
});
