registerAdminPage(function createPetMarketOrdersPage({ ui, api, showToast }) {
  const { byId, cell, stackedCell, actionButton, actionsCell, fillTable, formatDate } = ui;
  const root = byId('petMarketOrdersRoot');
  if (!root) return { id: 'pet-market-orders', load: async () => {} };
  // Only this static shell uses HTML; order data is rendered through textContent.
  root.innerHTML = `
    <section class="market-order-stats" aria-label="全部订单统计">
      <div><span>全部订单</span><strong id="marketOrderTotal">—</strong></div>
      <div><span>待付款</span><strong id="marketOrderPending">—</strong></div>
      <div><span>已付款</span><strong id="marketOrderPaid">—</strong></div>
      <div><span>已付总额</span><strong id="marketOrderRevenue">—</strong></div>
    </section>
    <section class="tool-panel">
      <div class="panel-heading inline-heading">
        <div><p class="eyebrow">桌宠小铺</p><h2>订单列表</h2></div>
        <div class="header-actions">
          <a href="#pet-market" class="button button-secondary">管理桌宠</a>
          <button id="refreshMarketOrders" type="button" class="button button-secondary">刷新订单</button>
        </div>
      </div>
      <p class="field-hint">金额和资源版本按下单时记录展示。免费领取不产生付款订单。上方统计为全部订单，不随筛选变化。</p>
      <form id="marketOrderFilters" class="pet-market-filters market-order-filters">
        <label><span>搜索订单</span><input id="marketOrderSearch" type="search" maxlength="100" placeholder="昵称、设备号、订单号、备注码、桌宠或账号" autocomplete="off"></label>
        <label><span>订单状态</span><select id="marketOrderStatus"><option value="">全部状态</option><option value="pending_payment">待付款</option><option value="paid">已付款</option><option value="canceled">已取消</option><option value="expired">已过期</option></select></label>
        <label><span>每页条数</span><select id="marketOrderPageSize"><option value="25">25 条</option><option value="50">50 条</option><option value="100">100 条</option></select></label>
        <button type="submit" class="button button-primary">查询</button>
        <button id="clearMarketOrderFilters" type="button" class="button button-secondary">重置</button>
      </form>
      <p id="marketOrdersNotice" class="field-hint" role="status" aria-live="polite"></p>
      <p id="marketOrdersError" class="form-error" role="alert" hidden></p>
      <div class="table-wrap"><table class="market-orders-table">
        <thead><tr><th>订单 / 备注码</th><th>桌宠 / 版本</th><th>购买者 / 设备</th><th>金额</th><th>状态</th><th>下单 / 付款时间</th><th class="actions-column">操作</th></tr></thead>
        <tbody id="marketOrderRows"></tbody>
      </table><p id="emptyMarketOrders" class="empty-state" hidden>暂无订单。</p></div>
      <div class="list-pagination market-order-pagination">
        <span id="marketOrderPageInfo">尚未加载</span>
        <div class="row-actions"><button id="marketOrdersPrevious" type="button" class="button button-secondary" disabled>上一页</button><button id="marketOrdersNext" type="button" class="button button-secondary" disabled>下一页</button></div>
      </div>
    </section>`;

  const labels = { pending_payment: '待付款', paid: '已付款', canceled: '已取消', expired: '已过期' };
  const tones = { pending_payment: 'pending', paid: 'paid', canceled: 'muted', expired: 'muted' };
  const state = { page: 1, pageSize: 25, q: '', status: '' };
  let requestVersion = 0;
  let total = 0;
  let loading = false;
  const confirmingOrders = new Set();
  const canConfirm = order => ['pending_payment', 'expired', 'canceled'].includes(order.status);
  const amount = fen => Number.isSafeInteger(fen) ? `¥${(fen / 100).toFixed(2)}` : '—';
  const date = value => value ? formatDate(value) : '—';
  const hasBuyerDevice = order => order.buyerDeviceSource === 'order_snapshot' && Boolean(order.buyerInstallationId);
  const relatedDevices = order => !hasBuyerDevice(order) && Array.isArray(order.accountDevices) ? order.accountDevices : [];
  const deviceCode = device => device.deviceCode || String(device.installationId || '').slice(-12);
  const platform = value => ({ windows: 'Windows', macos: 'macOS', android: 'Android', ios: 'iOS' }[value] || value || '未记录');

  function buyerName(order) {
    if (!order.buyerDisplayName) return order.buyerNameSource === 'order_snapshot' ? '下单时未设置昵称' : '昵称未记录';
    return order.buyerNameSource === 'current_profile' ? `${order.buyerDisplayName}（当前昵称）` : order.buyerDisplayName;
  }

  function buyerCell(order) {
    const account = String(order.accountId || '');
    const exact = hasBuyerDevice(order);
    const devices = relatedDevices(order);
    const result = stackedCell('market-order-buyer', buyerName(order),
      exact ? `下单设备：${order.buyerDeviceCode || order.buyerInstallationId.slice(-12)}` : '下单设备：未记录',
      devices.length ? `关联设备（参考）：${devices.map(deviceCode).join('、')}` : null,
      account ? `账号：…${account.slice(-10)}` : '账号：未记录');
    result.title = exact ? `下单设备码：${order.buyerInstallationId}\n账号：${account}` : `账号：${account}`;
    return result;
  }

  function badge(order) {
    const node = document.createElement('span');
    node.className = `status-badge market-order-status ${tones[order.status] || 'muted'}`;
    node.textContent = order.status === 'paid' && order.confirmationMethod === 'manual'
      ? '已付款 · 手动确认' : labels[order.status] || '未知状态';
    return node;
  }

  async function copy(value, label) {
    try { await navigator.clipboard.writeText(String(value)); showToast(`${label}已复制`); }
    catch { showToast('复制失败，请在订单详情中选择并复制。', 'error'); }
  }

  function detailBody(order, forConfirmation = false) {
    const body = document.createElement('div');
    body.className = 'market-order-detail';
    body.append(badge(order));
    const hint = document.createElement('p');
    hint.className = 'field-hint';
    hint.textContent = forConfirmation
      ? order.status === 'pending_payment'
        ? '用于付款时忘记备注等情况。请先人工核对转账记录，再确认此订单；系统不会替你核实转账。'
        : '此订单已取消或过期。人工核对付款后仍可确认收款，订单将改为已付款并发放原订单的桌宠资源。'
      : order.status === 'paid'
      ? order.confirmationMethod === 'manual'
        ? '已由管理员手动确认收款。客户端同步订单后自动下载安装，启用由用户手动选择。'
        : order.confirmationMethod === 'automatic'
          ? '付款验证成功。客户端同步订单后自动下载安装，启用由用户手动选择。'
          : '付款已确认，历史确认来源未记录。客户端同步订单后自动下载安装，启用由用户手动选择。'
      : order.status === 'pending_payment' ? '等待付款核对。下单 15 分钟内未支付会过期。'
        : order.status === 'expired' ? '订单已过期，保留此记录供查询。' : '订单已取消，保留此记录供查询。';
    body.append(hint);
    const fields = [
      ['订单号', order.id], ['付款备注码', order.paymentReference], ['购买账号', order.accountId],
      [order.buyerNameSource === 'current_profile' ? '桌搭子昵称（当前）' : '桌搭子昵称（下单时）',
        order.buyerDisplayName || (order.buyerNameSource === 'order_snapshot' ? '下单时未设置昵称' : '未记录')],
      ['下单设备号', hasBuyerDevice(order) ? order.buyerDeviceCode || order.buyerInstallationId.slice(-12) : '历史订单未记录'],
      ['完整下单设备码', hasBuyerDevice(order) ? order.buyerInstallationId : '历史订单未记录'],
      ['下单设备平台', hasBuyerDevice(order) ? platform(order.buyerPlatform) : '未记录'],
      ['桌宠名称', order.productTitle || order.productId], ['商品标识', order.productId],
      ['锁定资源版本', order.productVersion], ['订单金额', amount(order.amountFen)],
      ['创建时间', date(order.createdAt)], ['到期时间', date(order.expiresAt)],
      ['付款确认时间', date(order.paidAt)], ['取消时间', date(order.canceledAt)]
    ];
    if (order.status === 'paid') {
      fields.push(['确认方式', order.confirmationMethod === 'manual' ? '手动确认'
        : order.confirmationMethod === 'automatic' ? '自动匹配' : '已确认 / 来源未记录']);
      if (order.confirmationMethod === 'manual' && order.manualConfirmation) {
        const audit = order.manualConfirmation;
        fields.push(['确认管理员', audit.confirmedBy], ['手动确认时间', date(audit.confirmedAt)],
          ['确认前状态', labels[audit.previousStatus] || '未记录'], ['人工核对说明', audit.note]);
      } else if (order.confirmationMethod === 'manual') {
        fields.push(['人工核对记录', '历史人工确认未记录操作人及核对说明']);
      }
    }
    const list = document.createElement('dl');
    for (const [label, value] of fields) {
      const term = document.createElement('dt'); term.textContent = label;
      const detail = document.createElement('dd'); detail.textContent = value || '—';
      list.append(term, detail);
    }
    body.append(list);
    if (!hasBuyerDevice(order)) {
      const referenceHint = document.createElement('p');
      referenceHint.className = 'field-hint';
      referenceHint.textContent = '此历史订单未记录下单设备。关联设备仅供查找账号，不能确认实际下单设备。';
      body.append(referenceHint);
      const devices = relatedDevices(order);
      const references = document.createElement('dl');
      for (const [index, device] of devices.entries()) {
        const term = document.createElement('dt'); term.textContent = `关联设备 ${index + 1}（参考）`;
        const detail = document.createElement('dd');
        detail.textContent = `${deviceCode(device)} · ${platform(device.platform)}\n完整设备码：${device.installationId || '未记录'}`;
        references.append(term, detail);
      }
      if (devices.length) body.append(references);
      else {
        const empty = document.createElement('p'); empty.className = 'field-hint'; empty.textContent = '暂无关联设备记录。'; body.append(empty);
      }
    }
    return body;
  }

  function openDetails(order) {
    const body = detailBody(order);
    const footer = [
      actionButton('复制订单号', 'button-secondary', () => copy(order.id, '订单号'))
    ];
    if (order.accountId) footer.push(actionButton('复制账号', 'button-secondary', () => copy(order.accountId, '账号')));
    if (hasBuyerDevice(order)) footer.push(actionButton('复制设备码', 'button-secondary', () => copy(order.buyerInstallationId, '设备码')));
    if (canConfirm(order)) footer.push(confirmActionButton(order));
    footer.push(actionButton('关闭', 'button-primary', () => globalThis.AdminFormKit.closeDrawer()));
    globalThis.AdminFormKit.openDrawer({ title: '订单详情', eyebrow: order.productTitle || order.productId, body, footer });
  }

  function confirmActionButton(order) {
    const button = actionButton('手动确认收款', 'button-primary', () => openConfirmation(order));
    button.disabled = confirmingOrders.has(order.id);
    return button;
  }

  function openConfirmation(order) {
    if (!canConfirm(order) || confirmingOrders.has(order.id)) return;
    const body = detailBody(order, true);
    const form = document.createElement('form');
    form.className = 'market-order-confirm-form';
    const noteLabel = document.createElement('label');
    const noteTitle = document.createElement('span'); noteTitle.textContent = '人工核对说明（必填）';
    const note = document.createElement('textarea');
    note.name = 'confirmationNote'; note.required = true; note.maxLength = 600; note.rows = 3;
    note.placeholder = '例如：付款人昵称、转账时间及核对依据，最多 600 字';
    noteLabel.append(noteTitle, note);
    const acknowledgment = document.createElement('label');
    acknowledgment.className = 'market-order-confirm-check';
    const received = document.createElement('input');
    received.type = 'checkbox'; received.name = 'received'; received.required = true;
    const acknowledgmentText = document.createElement('span');
    acknowledgmentText.textContent = '已核对转账记录，确认付款人及金额与此订单一致';
    acknowledgment.append(received, acknowledgmentText);
    const delivery = document.createElement('p'); delivery.className = 'field-hint';
    delivery.textContent = '确认后即发放桌宠。客户端同步订单后自动安装，用户自行启用；此操作不执行微信收款或转账。';
    const error = document.createElement('p');
    error.className = 'form-error'; error.setAttribute('role', 'alert'); error.hidden = true;
    form.append(noteLabel, acknowledgment, delivery, error);
    body.append(form);
    let submitting = false;
    const cancel = actionButton('返回详情', 'button-secondary', () => { if (!submitting) openDetails(order); });
    const submit = actionButton('确认收款并发放', 'button-primary', submitConfirmation);
    function setSubmitting(value) {
      submitting = value;
      submit.disabled = value; cancel.disabled = value; note.disabled = value; received.disabled = value;
      submit.textContent = value ? '正在确认…' : '确认收款并发放';
    }
    async function submitConfirmation() {
      if (submitting || confirmingOrders.has(order.id) || !canConfirm(order)) return;
      const explanation = note.value.trim();
      const problem = !explanation ? '请填写人工核对说明。' : explanation.length > 600
        ? '人工核对说明不能超过 600 字。' : !received.checked ? '请先核对转账记录并勾选确认。' : '';
      if (problem) {
        error.textContent = problem; error.hidden = false;
        if (!explanation || explanation.length > 600) note.focus(); else received.focus();
        return;
      }
      error.hidden = true; error.textContent = '';
      confirmingOrders.add(order.id); setSubmitting(true);
      try {
        const result = await api(`/api/admin/pet-market/orders/${encodeURIComponent(order.id)}/confirm-payment`, {
          method: 'POST', body: { note: explanation, expectedAmountFen: order.amountFen, received: true }
        });
        Object.assign(order, result.order);
        showToast(result.duplicate ? '此订单已确认付款，无需重复发放。' : '已确认收款并发放，客户端同步后自动安装。');
        // A different drawer may have been opened while this request was in flight.
        if (byId('drawerBody').contains(body) && !byId('editorDrawer').hidden) openDetails(order);
        await load();
      } catch (failure) {
        error.textContent = failure.message || '手动确认失败，请核对订单后重试。';
        error.hidden = false;
      } finally {
        confirmingOrders.delete(order.id); setSubmitting(false);
      }
    }
    form.addEventListener('submit', event => { event.preventDefault(); return submitConfirmation(); });
    globalThis.AdminFormKit.openDrawer({ title: '手动确认收款', eyebrow: '核对订单后发放桌宠', body, footer: [cancel, submit] });
    note.focus();
  }

  function renderRows(orders) {
    fillTable(byId('marketOrderRows'), orders, order => {
      const orderCell = stackedCell('market-order-id', order.paymentReference || '—', order.id);
      const statusCell = cell(); statusCell.append(badge(order));
      return [
        orderCell,
        stackedCell('market-order-product', order.productTitle || order.productId, `版本 ${order.productVersion || '—'}`),
        buyerCell(order), cell('market-order-amount', amount(order.amountFen)), statusCell,
        stackedCell('market-order-dates', date(order.createdAt), order.paidAt ? `付款 ${date(order.paidAt)}` : '尚未付款'),
        actionsCell(actionButton('查看详情', 'button-secondary', () => openDetails(order)),
          ...(canConfirm(order) ? [confirmActionButton(order)] : []))
      ];
    }, byId('emptyMarketOrders'));
    byId('emptyMarketOrders').textContent = state.q || state.status
      ? '没有匹配的订单，试试其他关键词或状态。' : '还没有付款订单。用户下单后会显示在这里。';
  }

  function updateControls(failed = false) {
    byId('refreshMarketOrders').disabled = loading;
    byId('refreshMarketOrders').textContent = loading ? '正在加载…' : '刷新订单';
    byId('marketOrdersPrevious').disabled = loading || failed || state.page <= 1;
    byId('marketOrdersNext').disabled = loading || failed || state.page * state.pageSize >= total;
  }

  async function load() {
    const version = ++requestVersion;
    const requested = { ...state };
    loading = true;
    updateControls();
    byId('marketOrdersError').hidden = true;
    byId('marketOrdersNotice').textContent = '正在读取订单…';
    byId('marketOrderPageInfo').textContent = '正在加载…';
    byId('marketOrderRows').replaceChildren();
    byId('emptyMarketOrders').hidden = true;
    let failed = false;
    try {
      const query = new URLSearchParams({ page: String(requested.page), pageSize: String(requested.pageSize),
        status: requested.status, q: requested.q });
      const payload = await api(`/api/admin/pet-market/orders?${query}`);
      if (version !== requestVersion) return;
      total = payload.total;
      const lastPage = Math.max(1, Math.ceil(total / payload.pageSize));
      if (payload.page > lastPage) {
        state.page = lastPage;
        return await load();
      }
      state.page = payload.page;
      state.pageSize = payload.pageSize;
      renderRows(payload.orders || []);
      const summary = payload.summary || {};
      byId('marketOrderTotal').textContent = String(summary.total ?? 0);
      byId('marketOrderPending').textContent = String(summary.pending ?? 0);
      byId('marketOrderPaid').textContent = String(summary.paid ?? 0);
      byId('marketOrderRevenue').textContent = amount(summary.paidAmountFen);
      byId('marketOrdersNotice').textContent = `全部订单中，已取消 ${summary.canceled || 0} 笔，已过期 ${summary.expired || 0} 笔。更新于 ${date(payload.serverTime)}。`;
      byId('marketOrderPageInfo').textContent = `共 ${total} 笔 · 第 ${state.page} / ${Math.max(1, Math.ceil(total / state.pageSize))} 页`;
    } catch (error) {
      if (version !== requestVersion) return;
      failed = true;
      byId('marketOrdersError').hidden = false;
      byId('marketOrdersError').textContent = error.message || '订单加载失败，请刷新重试。';
      byId('marketOrdersNotice').textContent = '读取失败，请刷新重试。';
      byId('marketOrderPageInfo').textContent = '订单未加载';
      for (const id of ['marketOrderTotal', 'marketOrderPending', 'marketOrderPaid', 'marketOrderRevenue']) byId(id).textContent = '—';
    } finally {
      if (version === requestVersion) { loading = false; updateControls(failed); }
    }
  }

  function applyFilters() {
    state.q = byId('marketOrderSearch').value.trim();
    state.status = byId('marketOrderStatus').value;
    state.pageSize = Number(byId('marketOrderPageSize').value);
    state.page = 1;
    return load();
  }
  byId('marketOrderFilters').addEventListener('submit', event => { event.preventDefault(); return applyFilters(); });
  byId('marketOrderStatus').addEventListener('change', applyFilters);
  byId('marketOrderPageSize').addEventListener('change', applyFilters);
  byId('clearMarketOrderFilters').addEventListener('click', () => {
    byId('marketOrderSearch').value = ''; byId('marketOrderStatus').value = ''; byId('marketOrderPageSize').value = '25';
    return applyFilters();
  });
  byId('refreshMarketOrders').addEventListener('click', load);
  byId('marketOrdersPrevious').addEventListener('click', () => { if (!loading && state.page > 1) { state.page--; return load(); } });
  byId('marketOrdersNext').addEventListener('click', () => { if (!loading && state.page * state.pageSize < total) { state.page++; return load(); } });
  return { id: 'pet-market-orders', load };
});
