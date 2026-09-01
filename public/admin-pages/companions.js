registerAdminPage(function createCompanionsPage({ ui, api, showToast, showLogin }) {
  const {
    byId, setText, bindClick, bindSubmit, formatBytes, formatDate, formatRate, cell,
    fillTable, createListView, loadJson, withBusy
  } = ui;

  const platformLabel = { windows: 'Windows', macos: 'macOS', android: 'Android' };

  function fillSelect(select, items, emptyText) {
    if (!select) return;
    const previous = select.value;
    select.replaceChildren();
    if (!items.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = emptyText;
      select.append(option);
      return;
    }
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '请选择';
    select.append(placeholder);
    for (const item of items) {
      const option = document.createElement('option');
      option.value = item.value;
      option.textContent = item.label;
      select.append(option);
    }
    if (previous && items.some((item) => item.value === previous)) select.value = previous;
  }

  function senderOptions(payload) {
    return (payload.sendOptions?.senders || []).map((item) => ({
      value: item.accountId,
      label: `${item.displayName} · …${item.accountSuffix}`
    }));
  }

  function recipientOptions(payload) {
    const senderId = byId('companionSendSender')?.value;
    return (payload.sendOptions?.devices || [])
      .filter((item) => item.accountId !== senderId)
      .map((item) => ({
        value: item.licenseId,
        label: [
          item.displayName,
          `…${item.accountSuffix}`,
          platformLabel[item.platform] || item.platform,
          item.appVersion,
          `设备 …${item.installationSuffix}`
        ].filter(Boolean).join(' · ')
      }));
  }

  function fillSendOptions(payload) {
    const windowMinutes = payload.sendOptions?.onlineWindowMinutes || 5;
    fillSelect(byId('companionSendSender'), senderOptions(payload), '暂无可用发送账号');
    fillSelect(
      byId('companionSendRecipient'),
      recipientOptions(payload),
      `暂无 ${windowMinutes} 分钟内在线设备`
    );
    setText('companionSendHint', `${windowMinutes} 分钟内有心跳的设备会出现在列表里`);
  }

  function hallStatus(item) {
    if (!item.hallEnabled) return 'disabled';
    return item.online ? 'online' : 'offline';
  }

  const pairList = createListView('companion-pairs', {
    emptyElement: byId('emptyCompanionPairs'),
    renderPage(items) {
      fillTable(byId('companionPairRows'), items, (item) => [
        cell('', item.firstName),
        cell('hash', `…${item.firstAccountSuffix}`),
        cell('', item.secondName),
        cell('hash', `…${item.secondAccountSuffix}`),
        cell('', formatDate(item.pairedAt))
      ]);
    }
  });

  const profileList = createListView('companion-profiles', {
    emptyElement: byId('emptyCompanionProfiles'),
    renderPage(items) {
      fillTable(byId('companionProfileRows'), items, (item) => [
        cell('', item.displayName),
        cell('hash', `…${item.accountSuffix}`),
        cell('', item.partner ? `${item.partner.displayName} · …${item.partner.accountSuffix}` : '未绑定'),
        cell('', item.hallEnabled ? (item.online ? '大厅在线' : '大厅离线') : '未开启'),
        cell('', item.lastSeenAt ? formatDate(item.lastSeenAt) : '-'),
        cell('', formatDate(item.updatedAt))
      ]);
    },
    matches: (item, filters) => (!filters.hall || hallStatus(item) === filters.hall)
      && (!filters.paired || (item.partner ? 'paired' : 'unpaired') === filters.paired)
  });

  const deliveryStatus = { received: '已领取', pending: '待领取', expired: '已过期' };
  const deliveryList = createListView('companion-deliveries', {
    emptyElement: byId('emptyCompanionDeliveries'),
    renderPage(items) {
      fillTable(byId('companionDeliveryRows'), items, (item) => [
        cell('', item.source === 'hall' ? '陌生人大厅' : item.source === 'admin' ? '管理后台' : '绑定搭子'),
        cell('', `${item.sender.displayName} · …${item.sender.accountSuffix}`),
        cell('', `${item.recipient.displayName} · …${item.recipient.accountSuffix}`),
        cell('', item.message || '-'),
        cell('', formatBytes(item.size)),
        cell('', deliveryStatus[item.status] || item.status),
        cell('', formatDate(item.createdAt))
      ]);
    },
    matches: (item, filters) => (!filters.source || item.source === filters.source)
      && (!filters.status || item.status === filters.status)
  });

  function renderCompanions(payload) {
    const summary = payload.summary || {};
    setText('companionProfiles', summary.profiles || 0);
    setText('companionPairs', summary.activePairs || 0);
    setText('companionSent', summary.sent || 0);
    setText('companionReceived', summary.received || 0);
    setText('companionPending', summary.pending || 0);
    setText('companionExpired', summary.expired || 0);
    const receiptLabel = summary.receiptRate === null ? '-' : formatRate(summary.receiptRate);
    setText('companionReceiptRate', receiptLabel);
    const todoCompanions = byId('overviewTodoCompanions');
    if (todoCompanions) {
      todoCompanions.textContent = summary.pending > 0
        ? `还有 ${summary.pending} 条待领取，领取率 ${receiptLabel}`
        : `近 90 天领取率 ${receiptLabel}`;
    }
    setText('companionStorage', formatBytes(summary.storageBytes || 0));
    setText('companionUpdatedAt', `更新于 ${formatDate(payload.generatedAt)}`);

    fillTable(byId('companionRows'), payload.daily || [], (item) => [
      cell('', item.date),
      cell('', item.sent),
      cell('', item.received),
      cell('', item.expired),
      cell('', item.sent > 0 ? formatRate(item.received / item.sent) : '-')
    ], byId('emptyCompanions'));
    pairList.setItems(payload.pairs || []);
    profileList.setItems(payload.profiles || []);
    deliveryList.setItems(payload.recentDeliveries || []);
    fillSendOptions(payload);
  }

  let latestPayload = { sendOptions: { senders: [], devices: [], onlineWindowMinutes: 5 } };

  async function loadCompanions() {
    await loadJson('/api/admin/companions', (payload) => {
      latestPayload = payload;
      renderCompanions(payload);
    }, byId('refreshCompanionButton'));
  }

  const senderSelect = byId('companionSendSender');
  if (senderSelect) {
    senderSelect.addEventListener('change', () => fillSendOptions(latestPayload));
  }
  bindSubmit('companionSendForm', async () => {
    const form = byId('companionSendForm');
    const fileInput = byId('companionSendFile');
    const button = byId('companionSendButton');
    const file = fileInput?.files?.[0];
    const senderAccountId = byId('companionSendSender')?.value;
    const recipientLicenseId = byId('companionSendRecipient')?.value;
    if (!file || !senderAccountId || !recipientLicenseId) {
      showToast('请选择发送账号、对方设备和 GIF', 'error');
      return;
    }
    const params = new URLSearchParams({
      senderAccountId,
      recipientLicenseId,
      message: byId('companionSendMessage')?.value.trim() || ''
    });
    await withBusy(button, async () => {
      await api(`/api/admin/companions/deliveries?${params}`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/gif' },
        body: file
      });
      form.reset();
      showToast('已发给对方桌宠');
      await loadCompanions();
    }, (error) => {
      if (error.status === 401) showLogin('登录已失效，请重新登录');
      showToast(error.message, 'error');
    });
  });
  bindClick('refreshCompanionButton', loadCompanions);
  return { load: loadCompanions };
});
