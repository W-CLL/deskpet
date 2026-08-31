registerAdminPage(function createCompanionsPage({ ui }) {
  const {
    byId, setText, bindClick, formatBytes, formatDate, formatRate, cell, fillTable, loadJson
  } = ui;

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

    fillTable(byId('companionPairRows'), payload.pairs || [], (item) => [
      cell('', item.firstName),
      cell('hash', `…${item.firstAccountSuffix}`),
      cell('', item.secondName),
      cell('hash', `…${item.secondAccountSuffix}`),
      cell('', formatDate(item.pairedAt))
    ], byId('emptyCompanionPairs'));

    fillTable(byId('companionProfileRows'), payload.profiles || [], (item) => [
      cell('', item.displayName),
      cell('hash', `…${item.accountSuffix}`),
      cell('', item.partner ? `${item.partner.displayName} · …${item.partner.accountSuffix}` : '未绑定'),
      cell('', item.hallEnabled ? (item.online ? '大厅在线' : '大厅离线') : '未开启'),
      cell('', item.lastSeenAt ? formatDate(item.lastSeenAt) : '-'),
      cell('', formatDate(item.updatedAt))
    ], byId('emptyCompanionProfiles'));

    const deliveryStatus = { received: '已领取', pending: '待领取', expired: '已过期' };
    fillTable(byId('companionDeliveryRows'), payload.recentDeliveries || [], (item) => [
      cell('', item.source === 'hall' ? '陌生人大厅' : '绑定搭子'),
      cell('', `${item.sender.displayName} · …${item.sender.accountSuffix}`),
      cell('', `${item.recipient.displayName} · …${item.recipient.accountSuffix}`),
      cell('', item.message || '-'),
      cell('', formatBytes(item.size)),
      cell('', deliveryStatus[item.status] || item.status),
      cell('', formatDate(item.createdAt))
    ], byId('emptyCompanionDeliveries'));
  }

  async function loadCompanions() {
    await loadJson('/api/admin/companions', renderCompanions, byId('refreshCompanionButton'));
  }

  bindClick('refreshCompanionButton', loadCompanions);
  return { load: loadCompanions };
});
