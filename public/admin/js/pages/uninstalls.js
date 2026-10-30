registerAdminPage(function createUninstallsPage({ ui, api, showToast }) {
  const { byId, cell, stackedCell, actionButton, actionsCell, fillTable, formatDate } = ui;
  const root = byId('uninstallsRoot');
  if (!root) return { id: 'uninstalls', load: async () => {} };

  root.innerHTML = `
    <section class="market-order-stats" aria-label="设备安装状态统计">
      <div><span>记录设备</span><strong id="uninstallDeviceTotal">—</strong></div>
      <div><span>已报告卸载</span><strong id="uninstallReportedTotal">—</strong></div>
      <div><span>重装后恢复</span><strong id="uninstallRestoredTotal">—</strong></div>
      <div><span>卸载意向</span><strong id="uninstallIntentTotal">—</strong></div>
    </section>
    <section class="tool-panel">
      <div class="panel-heading inline-heading">
        <div><p class="eyebrow">设备生命周期</p><h2>卸载反馈与恢复记录</h2></div>
        <button id="refreshUninstalls" type="button" class="button button-secondary">刷新记录</button>
      </div>
      <p class="field-hint">只把卸载器在完成阶段确认的事件标为已卸载。离线、退出、关机、休眠和普通心跳不会推断卸载；购买权益与授权名额不在此处变更。</p>
      <form id="uninstallFilters" class="pet-market-filters market-order-filters">
        <label><span>搜索记录</span><input id="uninstallSearch" type="search" maxlength="100" placeholder="昵称、设备码、账号、平台、版本或原因" autocomplete="off"></label>
        <label><span>安装状态</span><select id="uninstallStatus"><option value="">全部状态</option><option value="installed">已安装</option><option value="uninstall_reported">已报告卸载</option><option value="restored">重装后恢复</option></select></label>
        <label><span>每页条数</span><select id="uninstallPageSize"><option value="25">25 条</option><option value="50">50 条</option><option value="100">100 条</option></select></label>
        <button type="submit" class="button button-primary">查询</button>
        <button id="clearUninstallFilters" type="button" class="button button-secondary">重置</button>
      </form>
      <p id="uninstallsNotice" class="field-hint" role="status" aria-live="polite"></p>
      <p id="uninstallsError" class="form-error" role="alert" hidden></p>
      <div class="table-wrap"><table class="uninstall-records-table">
        <thead><tr><th>设备 / 昵称</th><th>平台 / 版本</th><th>当前状态</th><th>最近反馈</th><th>卸载 / 恢复时间</th><th class="actions-column">操作</th></tr></thead>
        <tbody id="uninstallRows"></tbody>
      </table><p id="emptyUninstalls" class="empty-state" hidden>暂无卸载反馈或安装批次记录。</p></div>
      <div class="list-pagination market-order-pagination">
        <span id="uninstallPageInfo">尚未加载</span>
        <div class="row-actions"><button id="uninstallsPrevious" type="button" class="button button-secondary" disabled>上一页</button><button id="uninstallsNext" type="button" class="button button-secondary" disabled>下一页</button></div>
      </div>
    </section>`;

  const statusLabels = { installed: '已安装', uninstall_reported: '已报告卸载', restored: '重装后恢复' };
  const statusTones = { installed: 'paid', uninstall_reported: 'warning', restored: 'info' };
  const eventLabels = { installed_start: '联网启动', uninstall_intent: '卸载意向', uninstall_completed: '卸载完成' };
  const reasonLabels = {
    not_often_used: '不常用', resource_usage: '占用资源', experience_issue: '体验问题',
    temporary_pause: '暂时不用', other: '其他'
  };
  const platformLabel = value => ({ windows: 'Windows', macos: 'macOS' }[value] || value || '未记录');
  const date = value => value ? formatDate(value) : '—';
  const state = { page: 1, pageSize: 25, q: '', status: '' };
  let requestVersion = 0;
  let total = 0;
  let loading = false;

  function badge(status) {
    const node = document.createElement('span');
    node.className = `status-badge market-order-status ${statusTones[status] || 'muted'}`;
    node.textContent = statusLabels[status] || '未知状态';
    return node;
  }

  async function copy(value, label) {
    try { await navigator.clipboard.writeText(String(value)); showToast(`${label}已复制`); }
    catch { showToast('复制失败，请在详情中选择并复制。', 'error'); }
  }

  function feedbackText(device) {
    const reason = reasonLabels[device.latestReason] || (device.latestReason ? device.latestReason : '跳过反馈');
    return device.latestComment ? `${reason}：${device.latestComment}` : reason;
  }

  async function openDetails(device) {
    const body = document.createElement('div');
    body.className = 'market-order-detail';
    const loadingText = document.createElement('p');
    loadingText.className = 'field-hint';
    loadingText.textContent = '正在读取完整历史…';
    body.append(badge(device.status), loadingText);
    const footer = [
      actionButton('复制设备码', 'button-secondary', () => copy(device.installationId, '设备码')),
      actionButton('关闭', 'button-primary', () => globalThis.AdminFormKit.closeDrawer())
    ];
    globalThis.AdminFormKit.openDrawer({ title: '卸载与恢复详情', eyebrow: device.displayName || '桌搭子', body, footer });
    try {
      const payload = await api(`/api/admin/uninstalls/${encodeURIComponent(device.installationId)}`);
      body.replaceChildren(badge(payload.device.status));
      const fields = [
        ['桌搭子昵称', payload.device.displayName || '未记录'],
        ['完整设备码', payload.device.installationId],
        ['账号', payload.device.accountId],
        ['授权记录', payload.device.licenseId],
        ['平台', platformLabel(payload.device.platform)],
        ['客户端版本', payload.device.appVersion || '未记录'],
        ['当前安装批次', payload.device.currentInstallBatchId],
        ['批次创建时间', date(payload.device.currentInstallBatchCreatedAt)],
        ['最近卸载完成', date(payload.device.lastUninstallAt)],
        ['最近重装恢复', date(payload.device.lastRestoredAt)]
      ];
      const list = document.createElement('dl');
      for (const [label, value] of fields) {
        const term = document.createElement('dt'); term.textContent = label;
        const detail = document.createElement('dd'); detail.textContent = value || '—';
        list.append(term, detail);
      }
      body.append(list);
      const heading = document.createElement('h3'); heading.textContent = '事件历史'; body.append(heading);
      for (const event of payload.events || []) {
        const item = document.createElement('div'); item.className = 'uninstall-event-row';
        const title = document.createElement('strong');
        title.textContent = `${eventLabels[event.eventType] || event.eventType} · ${date(event.occurredAt)}`;
        const meta = document.createElement('p'); meta.className = 'field-hint';
        const reason = event.reason ? ` · 原因：${reasonLabels[event.reason] || event.reason}` : '';
        const ignored = event.ignoredAsStale ? ` · 未改状态（${event.ignoredReason}）` : '';
        meta.textContent = `${platformLabel(event.platform)} ${event.appVersion || ''} · 批次 ${event.installBatchId}${reason}${ignored}`;
        item.append(title, meta);
        if (event.comment) { const comment = document.createElement('p'); comment.textContent = event.comment; item.append(comment); }
        body.append(item);
      }
    } catch (error) {
      loadingText.textContent = error.message || '详情加载失败，请重试。';
    }
  }

  function renderRows(devices) {
    fillTable(byId('uninstallRows'), devices, device => {
      const statusCell = cell(); statusCell.append(badge(device.status));
      return [
        stackedCell('uninstall-device', device.displayName || '桌搭子', `设备号 ${device.deviceCode}`, `账号 …${String(device.accountId || '').slice(-10)}`),
        stackedCell('uninstall-platform', platformLabel(device.platform), `版本 ${device.appVersion || '未记录'}`),
        statusCell,
        stackedCell('uninstall-feedback', feedbackText(device), device.latestFeedbackAt ? date(device.latestFeedbackAt) : '尚无反馈'),
        stackedCell('uninstall-dates', `卸载 ${date(device.lastUninstallAt)}`, `恢复 ${date(device.lastRestoredAt)}`),
        actionsCell(actionButton('查看详情', 'button-secondary', () => openDetails(device)))
      ];
    }, byId('emptyUninstalls'));
    byId('emptyUninstalls').textContent = state.q || state.status
      ? '没有匹配的设备记录，试试其他关键词或状态。' : '暂无卸载反馈或安装批次记录。';
  }

  function updateControls(failed = false) {
    byId('refreshUninstalls').disabled = loading;
    byId('refreshUninstalls').textContent = loading ? '正在加载…' : '刷新记录';
    byId('uninstallsPrevious').disabled = loading || failed || state.page <= 1;
    byId('uninstallsNext').disabled = loading || failed || state.page * state.pageSize >= total;
  }

  async function load() {
    const version = ++requestVersion;
    const requested = { ...state };
    loading = true;
    updateControls();
    byId('uninstallsError').hidden = true;
    byId('uninstallsNotice').textContent = '正在读取卸载与恢复记录…';
    byId('uninstallRows').replaceChildren();
    byId('emptyUninstalls').hidden = true;
    let failed = false;
    try {
      const query = new URLSearchParams({ page: String(requested.page), pageSize: String(requested.pageSize),
        status: requested.status, q: requested.q });
      const payload = await api(`/api/admin/uninstalls?${query}`);
      if (version !== requestVersion) return;
      total = payload.total;
      const lastPage = Math.max(1, Math.ceil(total / payload.pageSize));
      if (payload.page > lastPage) { state.page = lastPage; return await load(); }
      state.page = payload.page; state.pageSize = payload.pageSize;
      renderRows(payload.devices || []);
      const summary = payload.summary || {};
      byId('uninstallDeviceTotal').textContent = String(summary.total ?? 0);
      byId('uninstallReportedTotal').textContent = String(summary.uninstallReported ?? 0);
      byId('uninstallRestoredTotal').textContent = String(summary.restored ?? 0);
      byId('uninstallIntentTotal').textContent = String(summary.intents ?? 0);
      byId('uninstallsNotice').textContent = `已安装 ${summary.installed || 0} 台；可信卸载完成事件 ${summary.completedEvents || 0} 条。更新于 ${date(payload.serverTime)}。`;
      byId('uninstallPageInfo').textContent = `共 ${total} 台 · 第 ${state.page} / ${lastPage} 页`;
    } catch (error) {
      if (version !== requestVersion) return;
      failed = true;
      byId('uninstallsError').hidden = false;
      byId('uninstallsError').textContent = error.message || '卸载记录加载失败，请刷新重试。';
      byId('uninstallsNotice').textContent = '读取失败，请刷新重试。';
      byId('uninstallPageInfo').textContent = '记录未加载';
      for (const id of ['uninstallDeviceTotal', 'uninstallReportedTotal', 'uninstallRestoredTotal', 'uninstallIntentTotal']) byId(id).textContent = '—';
    } finally {
      if (version === requestVersion) { loading = false; updateControls(failed); }
    }
  }

  function applyFilters() {
    state.q = byId('uninstallSearch').value.trim();
    state.status = byId('uninstallStatus').value;
    state.pageSize = Number(byId('uninstallPageSize').value);
    state.page = 1;
    return load();
  }
  byId('uninstallFilters').addEventListener('submit', event => { event.preventDefault(); return applyFilters(); });
  byId('uninstallStatus').addEventListener('change', applyFilters);
  byId('uninstallPageSize').addEventListener('change', applyFilters);
  byId('clearUninstallFilters').addEventListener('click', () => {
    byId('uninstallSearch').value = ''; byId('uninstallStatus').value = ''; byId('uninstallPageSize').value = '25';
    return applyFilters();
  });
  byId('refreshUninstalls').addEventListener('click', load);
  byId('uninstallsPrevious').addEventListener('click', () => { if (!loading && state.page > 1) { state.page--; return load(); } });
  byId('uninstallsNext').addEventListener('click', () => { if (!loading && state.page * state.pageSize < total) { state.page++; return load(); } });
  return { id: 'uninstalls', load };
});
