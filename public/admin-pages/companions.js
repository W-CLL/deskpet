registerAdminPage(function createCompanionsPage({ ui }) {
  const {
    byId, setText, bindClick, formatBytes, formatDate, formatRate, cell, fillTable,
    createListView, loadJson
  } = ui;

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
        cell('', item.source === 'hall' ? '陌生人大厅' : '绑定搭子'),
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
  }

  async function loadCompanions() {
    await loadJson('/api/admin/companions', renderCompanions, byId('refreshCompanionButton'));
  }

  bindClick('refreshCompanionButton', loadCompanions);
  return { load: loadCompanions };
});
