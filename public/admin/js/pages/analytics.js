registerAdminPage(function createAnalyticsPage({ ui }) {
  const {
    byId, setText, bindSubmit, formatDate, formatRate, formatDay, cell, stackedCell,
    badgeCell, fillTable, createListView, loadJson
  } = ui;

  function initializeRange() {
    const end = new Date();
    const start = new Date(end.getTime() - 29 * 24 * 60 * 60 * 1000);
    byId('analyticsFrom').value = formatDay(start);
    byId('analyticsTo').value = formatDay(end);
  }

  const activityLabels = {
    online: '在线', recent: '近期活跃', inactive7: '7 天不活跃',
    inactive15: '15 天不活跃', revoked: '已撤销', expired: '体验已过期'
  };
  const featureLabels = {
    trial_visit: '体验来访', companion_pair: '绑定搭子', companion_unpair: '解除搭子',
    companion_send: '发送给搭子', companion_hall_send: '大厅发送',
    companion_hall_open: '开启大厅', companion_hall_close: '关闭大厅'
  };
  const categoryLabels = { girlfriend: '女友', friend: '好友', companion: '搭子' };

  const downloadList = createListView('usage-downloads', {
    emptyElement: byId('emptyUsageDownloads'),
    renderPage(items) {
      fillTable(byId('usageDownloadRows'), items, (item) => [
        cell('', item.platform),
        cell('', item.architecture),
        cell('', item.version),
        cell('', item.downloadCount),
        cell('', formatDate(item.lastDownloadAt))
      ]);
    },
    matches: (item, filters) => !filters.platform || item.platform === filters.platform,
    searchPlaceholder: '搜索平台、架构或版本',
    searchText: (item) => [item.platform, item.architecture, item.version]
  });

  function idleLabel(value) {
    const stamp = Date.parse(value);
    if (!Number.isFinite(stamp)) return '-';
    const minutes = Math.max(0, Math.floor((Date.now() - stamp) / 60000));
    if (minutes < 5) return '刚刚活跃';
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours} 小时前`;
    const days = Math.floor(hours / 24);
    return `${days} 天前`;
  }

  const deviceList = createListView('usage-devices', {
    emptyElement: byId('emptyUsageDevices'),
    renderPage(items) {
      fillTable(byId('usageDeviceRows'), items, (item) => {
        const authLabel = item.authorizationType === 'trial' ? '体验' : '已激活';
        const onlineLabel = item.online || item.activityStatus === 'online' ? '在线' : '离线';
        const code = item.activationCode || item.maskedCode || (item.authorizationType === 'trial' ? '—' : '-');
        return [
          badgeCell(authLabel, item.authorizationType === 'trial' ? 'warning' : 'active'),
          badgeCell(onlineLabel, item.online || item.activityStatus === 'online' ? 'active' : ''),
          cell('hash', code),
          cell('', item.activatedAt ? formatDate(item.activatedAt) : '-'),
          cell('', item.displayName || (item.authorizationType === 'trial' ? '体验设备' : '桌搭子')),
          cell('hash', item.deviceCode || item.installationSuffix || '-'),
          stackedCell(
            '',
            item.lastSeenAt ? formatDate(item.lastSeenAt) : '-',
            { text: idleLabel(item.lastSeenAt) }
          )
        ];
      });
    },
    matches: (item, filters) => (!filters.authorization
      || (item.authorizationType === 'trial' ? 'trial' : 'license') === filters.authorization)
      && (!filters.status || (
        filters.status === 'online'
          ? (item.online || item.activityStatus === 'online')
          : filters.status === 'offline'
            ? !(item.online || item.activityStatus === 'online')
            : item.activityStatus === filters.status
      )),
    searchPlaceholder: '搜索激活码、昵称、设备码',
    searchText: (item) => [
      item.activationCode,
      item.maskedCode,
      item.displayName,
      item.deviceCode,
      item.installationSuffix,
      item.accountId,
      item.authorizationType,
      item.platform,
      item.appVersion
    ]
  });

  const featureList = createListView('usage-features', {
    emptyElement: byId('emptyUsageFeatures'),
    renderPage(items) {
      fillTable(byId('usageFeatureRows'), items, (item) => {
        const feature = `${featureLabels[item.feature] || item.feature}${item.category ? ` · ${categoryLabels[item.category] || item.category}` : ''}`;
        const owner = item.accountId
          ? `账号 …${String(item.accountId).slice(-8)} / 设备 …${item.installationSuffix || '-'}`
          : `体验设备 …${item.installationSuffix || '-'}`;
        return [
          cell('', feature),
          cell('hash', owner),
          cell('', `${item.platform || 'unknown'} ${item.appVersion || ''}`.trim()),
          cell('', formatDate(item.occurredAt))
        ];
      });
    },
    matches: (item, filters) => !filters.feature || item.feature === filters.feature,
    searchPlaceholder: '搜索功能、设备或账号',
    searchText: (item) => [
      featureLabels[item.feature],
      item.feature,
      categoryLabels[item.category],
      item.category,
      item.accountId,
      item.installationSuffix,
      item.platform,
      item.appVersion
    ]
  });

  const apiList = createListView('usage-api', {
    emptyElement: byId('emptyUsageApi'),
    renderPage(items) {
      fillTable(byId('usageApiRows'), items, (item) => {
        const successRate = item.requestCount > 0
          ? formatRate(item.successfulRequests / item.requestCount)
          : '-';
        return [
          cell('hash', `${item.method} ${item.path}`),
          cell('', `${item.platform || 'unknown'} ${item.appVersion || ''}`.trim()),
          cell('', item.requestCount),
          cell('', `${item.successfulRequests} · ${successRate}`),
          cell('', formatDate(item.lastSeenAt))
        ];
      });
    },
    searchPlaceholder: '搜索接口、平台或版本',
    searchText: (item) => [item.method, item.path, item.platform, item.appVersion]
  });

  const cohortList = createListView('analytics-cohorts', {
    emptyElement: byId('emptyAnalyticsCohorts'),
    renderPage(items) {
      fillTable(byId('analyticsCohortRows'), items, (item) => [
        cell('', item.date),
        cell('', item.size),
        cell('', formatRate(item.d1Rate)),
        cell('', formatRate(item.d7Rate)),
        cell('', formatRate(item.d30Rate))
      ]);
    },
    searchPlaceholder: '搜索激活日期',
    searchText: (item) => [item.date]
  });

  function renderUsage(usage) {
    const summary = usage.summary || {};
    setText('usageReleaseDownloads', String(summary.releaseDownloads || 0));
    setText('usageTrackedDevices', String(summary.trackedDevices || 0));
    setText('usageOnlineDevices', String(summary.onlineDevices || 0));
    setText('usageInactive7', String(summary.inactive7Days || 0));
    setText('usageInactive15', String(summary.inactive15Days || 0));
    setText('usageTrialDevices', String(summary.trialDevices || 0));
    setText('usageActiveTrials', `当前有效 ${summary.activeTrials || 0}`);
    setText('usageCompanionVisits', String(summary.companionTrialVisits || 0));
    setText('usageApiRequests', String(summary.apiRequests || 0));
    setText('usageUpdatedAt', usage.generatedAt ? `更新于 ${formatDate(usage.generatedAt)}` : '-');
    downloadList.setItems(usage.downloads || []);
    deviceList.setItems(usage.devices || []);
    featureList.setItems(usage.featureEvents || []);
    apiList.setItems(usage.apiRoutes || []);
  }

  function renderAnalytics(payload) {
    const funnel = payload.funnel || {};
    const resourceDownloads = payload.resourceDownloads || {};
    const activity = payload.activity || {};
    setText('analyticsVisitors', String(funnel.uniqueVisitors || 0));
    setText('analyticsDownloads', String(funnel.downloadClicks || 0));
    setText('analyticsResourceDownloads', String(resourceDownloads.downloadClicks || 0));
    setText('analyticsClickRate', formatRate(funnel.clickRate));
    setText('analyticsFirstLaunches', String(funnel.firstLaunches || 0));
    setText('analyticsInstallRate', formatRate(funnel.installRate));
    setText('analyticsDownloadActivationRate', formatRate(funnel.downloadToActivationRate));
    setText('analyticsWeeklyActive', String(activity.weeklyActiveDevices || 0));
    renderUsage(payload.usage || {});

    fillTable(byId('analyticsPlatformRows'), payload.platforms || [], (item) => [
      cell('', item.platform),
      cell('', item.downloadClicks),
      cell('', item.activations),
      cell('', item.activeDevices)
    ]);
    cohortList.setItems(payload.retention?.cohorts || []);
    byId('analyticsEmpty').hidden = Boolean(
      funnel.uniqueVisitors || funnel.firstLaunches || resourceDownloads.downloadClicks
        || activity.weeklyActiveDevices
        || (payload.platforms || []).length || (payload.retention?.cohorts || []).length
    );
  }

  async function loadAnalytics() {
    const query = new URLSearchParams({
      from: byId('analyticsFrom').value,
      to: byId('analyticsTo').value
    });
    await loadJson(`/api/admin/analytics?${query}`, renderAnalytics, byId('refreshAnalyticsButton'));
  }

  initializeRange();
  bindSubmit('analyticsForm', loadAnalytics);
  return { id: 'analytics', load: loadAnalytics };
});
