registerAdminPage(function createSettingsPage({ ui, api, showToast }) {
  const { byId, withBusy, loadJson, copyText, bindSubmit, bindClick } = ui;

  function fillSiteSettings(settings) {
    byId('xianyuUrl').value = settings.xianyuUrl || '';
    byId('wechatId').value = settings.wechatId || '';
    byId('announcement').value = settings.announcement || '';
    const features = settings.features || {};
    byId('featureTrialVisits').checked = features.trialVisits !== false;
    byId('featureCompanionHall').checked = features.companionHall !== false;
    byId('featureFishMode').checked = features.fishMode !== false;
    byId('featureAutoUpdates').checked = features.autoUpdates !== false;
    const defaults = settings.defaults || {};
    byId('defaultPersonality').value = defaults.personality || 'lively';
    byId('defaultInteractionMode').value = defaults.interactionMode || 'standard';
    byId('defaultTheaterInterval').value = String(defaults.theaterIntervalSeconds || 300);
  }

  bindSubmit('siteSettingsForm', async () => {
    await withBusy(byId('saveSiteSettingsButton'), async () => {
      const settings = await api('/api/admin/site-settings', {
        method: 'PUT',
        body: {
          xianyuUrl: byId('xianyuUrl').value.trim(),
          wechatId: byId('wechatId').value.trim(),
          announcement: byId('announcement').value.trim(),
          features: {
            trialVisits: byId('featureTrialVisits').checked,
            companionHall: byId('featureCompanionHall').checked,
            fishMode: byId('featureFishMode').checked,
            autoUpdates: byId('featureAutoUpdates').checked
          },
          defaults: {
            personality: byId('defaultPersonality').value,
            interactionMode: byId('defaultInteractionMode').value,
            theaterIntervalSeconds: Number(byId('defaultTheaterInterval').value)
          }
        }
      });
      fillSiteSettings(settings);
      showToast('远程配置已保存');
    });
  });

  bindClick('copyAdminUrlButton', () => copyText(
    byId('adminUrl').value,
    byId('adminUrl'),
    '管理后台地址已复制',
    '已选中管理后台地址'
  ));
  bindClick('copyManifestButton', () => copyText(
    byId('manifestUrl').value,
    byId('manifestUrl'),
    '更新清单地址已复制',
    '已选中更新清单地址'
  ));

  return {
    load() {
      return loadJson('/api/admin/site-settings', fillSiteSettings);
    }
  };
});
