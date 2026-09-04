registerAdminPage(function createAnalyticsPage({ ui }) {
  const {
    byId, setText, bindSubmit, formatDate, formatRate, formatDay, cell, fillTable,
    createListView, loadJson
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

  const deviceList = createListView('usage-devices', {
    emptyElement: byId('emptyUsageDevices'),
    renderPage(items) {
      fillTable(byId('usageDeviceRows'), items, (item) => [
        cell('hash', `…${item.installationSuffix || '-'}`),
        cell('hash', item.accountId ? `…${String(item.accountId).slice(-8)}` : '-'),
        cell('', item.authorizationType === 'trial' ? '体验' : '正式授权'),
        cell('', `${item.platform || 'unknown'} / ${item.architecture || 'unknown'}`),
        cell('', item.appVersion || '-'),
        cell('', formatDate(item.lastSeenAt)),
        cell('', activityLabels[item.activityStatus] || item.activityStatus),
        cell('', item.requestCount || 0),
        cell('hash', item.lastPath || '-')
      ]);
    },
    matches: (item, filters) => (!filters.authorization
      || (item.authorizationType === 'trial' ? 'trial' : 'license') === filters.authorization)
      && (!filters.status || item.activityStatus === filters.status),
    searchPlaceholder: '搜索设备、账号、版本或接口',
    searchText: (item) => [
      item.installationSuffix,
      item.accountId,
      item.authorizationType,
      item.platform,
      item.architecture,
      item.appVersion,
      item.lastPath,
      activityLabels[item.activityStatus]
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
  return { load: loadAnalytics };
});
