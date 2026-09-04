registerAdminPage(function createFeedbackPage({ ui, api, showToast }) {
  const {
    byId, setText, bindClick, formatDate, cell, actionButton, stackedCell, actionsCell,
    fillTable, createListView, loadJson
  } = ui;

  const types = { problem: '问题反馈', suggestion: '功能建议' };
  const statuses = {
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

  const listView = createListView('feedback', {
    emptyElement: byId('emptyFeedback'),
    renderPage(items) {
      fillTable(byId('feedbackRows'), items, (item) => {
        const type = document.createElement('span');
        type.className = `feedback-type ${item.type}`;
        type.textContent = types[item.type] || '反馈';
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
        const feedbackCell = stackedCell('feedback-content', type, { tag: 'strong', text: item.title }, content, meta);

        const statusSelect = document.createElement('select');
        statusSelect.className = 'feedback-status-select';
        statusSelect.setAttribute('aria-label', `反馈“${item.title}”的状态`);
        for (const [value, label] of Object.entries(statuses)) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = label;
          option.selected = value === item.status;
          statusSelect.append(option);
        }
        const statusCell = cell();
        statusCell.append(statusSelect);

        const noteInput = document.createElement('textarea');
        noteInput.rows = 3;
        noteInput.maxLength = 1000;
        noteInput.placeholder = '可选，客户端可查看';
        noteInput.value = item.adminNote || '';
        const noteCell = cell('feedback-note-cell');
        noteCell.append(noteInput);

        const saveButton = actionButton('保存', 'button-secondary', () => (
          saveFeedback(item, statusSelect, noteInput, saveButton)
        ));
        return [feedbackCell, statusCell, noteCell, actionsCell(saveButton)];
      });
    },
    matches: (item, filters) => (!filters.type || item.type === filters.type)
      && (!filters.status || item.status === filters.status),
    searchPlaceholder: '搜索标题、内容、设备或备注',
    searchText: (item) => [
      item.title,
      item.content,
      item.adminNote,
      item.installationSuffix,
      item.platform,
      item.appVersion,
      types[item.type],
      statuses[item.status]
    ]
  });

  function renderFeedback(payload) {
    const summary = payload.summary || {};
    const active = (summary.pending || 0) + (summary.inProgress || 0);
    setText('overviewPendingFeedback', active);
    const todoFeedback = byId('overviewTodoFeedback');
    if (todoFeedback) {
      todoFeedback.textContent = active > 0
        ? `还有 ${active} 条待处理或进行中`
        : '暂时没有待处理反馈';
    }
    setText('feedbackTotal', summary.total || 0);
    setText('feedbackPending', summary.pending || 0);
    setText('feedbackInProgress', summary.inProgress || 0);
    setText('feedbackResolved', summary.resolved || 0);
    setText('feedbackClosed', summary.closed || 0);
    listView.setItems(payload.items);
  }

  async function loadFeedback() {
    await loadJson('/api/admin/feedback', renderFeedback, byId('refreshFeedbackButton'));
  }

  bindClick('refreshFeedbackButton', loadFeedback);
  return { load: loadFeedback };
});
