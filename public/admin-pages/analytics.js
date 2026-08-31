registerAdminPage(function createAnalyticsPage({ ui }) {
  const {
    byId, setText, bindSubmit, formatDate, formatRate, formatDay, cell, fillTable, loadJson
  } = ui;

  function initializeRange() {
    const end = new Date();
    const start = new Date(end.getTime() - 29 * 24 * 60 * 60 * 1000);
    byId('analyticsFrom').value = formatDay(start);
    byId('analyticsTo').value = formatDay(end);
  }

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

    fillTable(byId('usageDownloadRows'), usage.downloads || [], (item) => [
      cell('', item.platform),
      cell('', item.architecture),
      cell('', item.version),
      cell('', item.downloadCount),
      cell('', formatDate(item.lastDownloadAt))
    ], byId('emptyUsageDownloads'));

    const activityLabels = {
      online: '在线', recent: '近期活跃', inactive7: '7 天不活跃',
      inactive15: '15 天不活跃', revoked: '已撤销', expired: '体验已过期'
    };
    fillTable(byId('usageDeviceRows'), usage.devices || [], (item) => [
      cell('hash', `…${item.installationSuffix || '-'}`),
      cell('hash', item.accountId ? `…${String(item.accountId).slice(-8)}` : '-'),
      cell('', item.authorizationType === 'trial' ? '体验' : '正式授权'),
      cell('', `${item.platform || 'unknown'} / ${item.architecture || 'unknown'}`),
      cell('', item.appVersion || '-'),
      cell('', formatDate(item.lastSeenAt)),
      cell('', activityLabels[item.activityStatus] || item.activityStatus),
      cell('', item.requestCount || 0),
      cell('hash', item.lastPath || '-')
    ], byId('emptyUsageDevices'));

    const featureLabels = {
      trial_visit: '体验来访', companion_pair: '绑定搭子', companion_unpair: '解除搭子',
      companion_send: '发送给搭子', companion_hall_send: '大厅发送',
      companion_hall_open: '开启大厅', companion_hall_close: '关闭大厅'
    };
    const categoryLabels = { girlfriend: '女友', friend: '好友', companion: '搭子' };
    fillTable(byId('usageFeatureRows'), usage.featureEvents || [], (item) => {
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

    fillTable(byId('usageApiRows'), usage.apiRoutes || [], (item) => {
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
    fillTable(byId('analyticsCohortRows'), payload.retention?.cohorts || [], (item) => [
      cell('', item.date),
      cell('', item.size),
      cell('', formatRate(item.d1Rate)),
      cell('', formatRate(item.d7Rate)),
      cell('', formatRate(item.d30Rate))
    ]);
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
