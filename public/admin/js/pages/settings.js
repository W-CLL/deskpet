registerAdminPage(function createSettingsPage({ ui, api, showToast }) {
  const { byId, withBusy, copyText, bindSubmit, bindClick } = ui;
  let currentSiteSettings = {};
  let summaryTemplates = [];
  let summaryPreviewRefreshers = [];
  const summaryPlaceholders = [
    ['periodStart', '周期开始日期', '2026-09-18'],
    ['periodEnd', '周期结束日期', '2026-09-25'],
    ['interactionDays', '有互动的天数', '5'],
    ['totalInteractions', '互动总次数', '23'],
    ['quizzesAnswered', '已答题数', '12'],
    ['quizzesCorrect', '答对题数', '9'],
    ['moodRecords', '心情记录次数', '8'],
    ['moodDays', '记录心情的天数', '5'],
    ['moodSummary', '各种心情及记录次数', '开心 4 次、一般 3 次、疲惫 1 次'],
    ['happyCount', '开心的记录次数', '4'],
    ['offWorkDays', '回应下班的天数', '4'],
    ['overtimeDays', '回应加班的天数', '1']
  ];
  const summarySample = Object.fromEntries(summaryPlaceholders.map(([key, , value]) => [key, value]));

  function markSummariesChanged() {
    byId('dailySummarySaveState').textContent = '总结配置有未保存的修改，点击「保存配置」后生效。';
  }

  function summarySamplePeriod(kind) {
    const now = new Date();
    const time = byId(kind === 'weekly' ? 'weeklySummaryTime' : 'monthlySummaryTime').value;
    const [hour, minute] = /^\d{2}:\d{2}$/.test(time)
      ? time.split(':').map(Number) : kind === 'weekly' ? [18, 0] : [9, 0];
    let start;
    let end;
    if (kind === 'weekly') {
      const weekday = Number(byId('weeklySummaryWeekday').value || '5');
      end = new Date(now);
      end.setDate(end.getDate() - (end.getDay() - weekday + 7) % 7);
      end.setHours(hour, minute, 0, 0);
      if (end > now) end.setDate(end.getDate() - 7);
      start = new Date(end);
      start.setDate(start.getDate() - 7);
    } else {
      const release = new Date(now.getFullYear(), now.getMonth(), 1, hour, minute);
      const cutoff = new Date(now.getFullYear(), now.getMonth() - (now < release ? 1 : 0), 1);
      start = new Date(cutoff.getFullYear(), cutoff.getMonth() - 1, 1);
      end = new Date(cutoff.getFullYear(), cutoff.getMonth(), 0);
    }
    const pad = (number) => String(number).padStart(2, '0');
    const format = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
      + (kind === 'weekly' ? ` ${pad(date.getHours())}:${pad(date.getMinutes())}` : '');
    return { periodStart: format(start), periodEnd: format(end) };
  }

  function renderSummarySample(value, kind) {
    const sample = { ...summarySample, ...summarySamplePeriod(kind) };
    return value.replace(/\{([^{}]+)\}/g, (match, key) => Object.hasOwn(sample, key) ? sample[key] : match);
  }

  function validateTemplateText(input) {
    let message = '';
    if (/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.value)) {
      message = '总结模板只支持纯文字，不支持 HTML、尖括号或控制字符。';
    }
    const remaining = input.value.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (placeholder, key) => {
      if (!Object.hasOwn(summarySample, key)) {
        message = `不支持占位符 ${placeholder}，请使用「可用占位符」中的名称。`;
      }
      return '';
    });
    if (!message && /[{}]/.test(remaining)) message = '占位符格式有误，请使用说明中完整的名称和花括号。';
    input.setCustomValidity(message);
  }

  function renderSummaryTemplates(focusId) {
    const list = byId('dailySummaryTemplates');
    list.replaceChildren();
    summaryPreviewRefreshers = [];
    byId('dailySummaryTemplateCount').textContent = `（${summaryTemplates.length}/40）`;
    byId('addWeeklySummaryTemplate').disabled = summaryTemplates.length >= 40;
    byId('addMonthlySummaryTemplate').disabled = summaryTemplates.length >= 40;
    if (!summaryTemplates.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = '暂无模板，新增周模板或月模板后填写内容。';
      list.append(empty);
    }

    for (const [index, item] of summaryTemplates.entries()) {
      const card = document.createElement('section');
      card.className = 'daily-summary-template';
      const heading = document.createElement('div');
      heading.className = 'form-section-heading';
      const label = document.createElement('strong');
      label.textContent = `模板 ${index + 1}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'button button-ghost';
      remove.textContent = '移除';
      remove.setAttribute('aria-label', `移除模板 ${index + 1}`);
      remove.addEventListener('click', () => {
        summaryTemplates = summaryTemplates.filter((entry) => entry.id !== item.id);
        renderSummaryTemplates();
        markSummariesChanged();
      });
      heading.append(label, remove);

      const controls = document.createElement('div');
      controls.className = 'daily-summary-template-controls';
      const kindLabel = document.createElement('label');
      const kindText = document.createElement('span');
      kindText.textContent = '总结类型';
      const kind = document.createElement('select');
      for (const [value, text] of [['weekly', '周总结'], ['monthly', '月总结']]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        kind.append(option);
      }
      kind.value = item.kind;
      kindLabel.append(kindText, kind);
      const enabledLabel = document.createElement('label');
      enabledLabel.className = 'settings-switch';
      const enabled = document.createElement('input');
      enabled.type = 'checkbox';
      enabled.checked = item.enabled !== false;
      const enabledText = document.createElement('span');
      enabledText.textContent = '启用此模板';
      enabledLabel.append(enabled, enabledText);
      controls.append(kindLabel, enabledLabel);

      const titleLabel = document.createElement('label');
      const titleText = document.createElement('span');
      titleText.textContent = '标题';
      const title = document.createElement('input');
      title.type = 'text';
      title.maxLength = 80;
      title.required = true;
      title.value = item.title || '';
      title.placeholder = '给这次回顾取一个名字';
      title.dataset.summaryTemplateId = item.id;
      titleLabel.append(titleText, title);
      const bodyLabel = document.createElement('label');
      const bodyText = document.createElement('span');
      bodyText.textContent = '正文';
      const body = document.createElement('textarea');
      body.rows = 4;
      body.maxLength = 2000;
      body.required = true;
      body.value = item.body || '';
      body.placeholder = '写下桌宠对这段日子的回顾，可插入上方列出的占位符。';
      bodyLabel.append(bodyText, body);

      const preview = document.createElement('details');
      preview.className = 'daily-summary-preview';
      const previewHeading = document.createElement('summary');
      previewHeading.textContent = '预览示例（使用演示数据）';
      const previewTitle = document.createElement('strong');
      const previewBody = document.createElement('p');
      preview.append(previewHeading, previewTitle, previewBody);
      const updatePreview = () => {
        previewTitle.textContent = renderSummarySample(item.title, item.kind) || '尚未填写标题';
        previewBody.textContent = renderSummarySample(item.body, item.kind) || '尚未填写正文';
      };
      summaryPreviewRefreshers.push(updatePreview);
      kind.addEventListener('change', () => {
        item.kind = kind.value;
        updatePreview();
        markSummariesChanged();
      });
      enabled.addEventListener('change', () => {
        item.enabled = enabled.checked;
        markSummariesChanged();
      });
      for (const [input, field] of [[title, 'title'], [body, 'body']]) {
        validateTemplateText(input);
        input.addEventListener('input', () => {
          item[field] = input.value;
          validateTemplateText(input);
          updatePreview();
          markSummariesChanged();
        });
      }
      updatePreview();
      card.append(heading, controls, titleLabel, bodyLabel, preview);
      list.append(card);
      if (item.id === focusId) title.focus();
    }
  }

  function fillDailySummaries(settings) {
    const summaries = settings.dailySummaries || {};
    byId('dailySummariesEnabled').checked = summaries.enabled !== false;
    byId('weeklySummaryEnabled').checked = summaries.weekly?.enabled !== false;
    byId('weeklySummaryWeekday').value = String(summaries.weekly?.weekday ?? 5);
    byId('weeklySummaryTime').value = summaries.weekly?.time || '18:00';
    byId('monthlySummaryEnabled').checked = summaries.monthly?.enabled !== false;
    byId('monthlySummaryTime').value = summaries.monthly?.time || '09:00';
    summaryTemplates = (Array.isArray(summaries.templates) ? summaries.templates : [])
      .map((item) => ({ ...item }));
    renderSummaryTemplates();
    byId('dailySummarySaveState').textContent = '模板由后台管理，客户端同步后使用最新配置。';
  }

  function dailySummaryPayload() {
    const summaries = currentSiteSettings.dailySummaries || {};
    const templates = summaryTemplates.map((item) => ({
      ...item,
      title: item.title.trim(),
      body: item.body.trim()
    }));
    if (templates.some((item) => !item.title || !item.body)) {
      throw new Error('请填写每份模板的标题和正文，或移除空白模板。');
    }
    const enabled = byId('dailySummariesEnabled').checked;
    const weeklyEnabled = byId('weeklySummaryEnabled').checked;
    const monthlyEnabled = byId('monthlySummaryEnabled').checked;
    for (const [kind, active, name] of [
      ['weekly', weeklyEnabled, '周总结'], ['monthly', monthlyEnabled, '月总结']
    ]) {
      if (active && !templates.some((item) => item.kind === kind && item.enabled)) {
        throw new Error(`${name}至少需要一份已启用模板。`);
      }
    }
    return {
      ...summaries,
      schemaVersion: 1,
      enabled,
      weekly: {
        ...summaries.weekly,
        enabled: weeklyEnabled,
        weekday: Number(byId('weeklySummaryWeekday').value),
        time: byId('weeklySummaryTime').value
      },
      monthly: {
        ...summaries.monthly,
        enabled: monthlyEnabled,
        time: byId('monthlySummaryTime').value
      },
      templates
    };
  }

  function fillSiteSettings(settings) {
    currentSiteSettings = settings;
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
    fillDailySummaries(settings);
  }

  bindSubmit('siteSettingsForm', async () => {
    await withBusy(byId('saveSiteSettingsButton'), async () => {
      const settings = await api('/api/admin/site-settings', {
        method: 'PUT',
        body: {
          ...currentSiteSettings,
          xianyuUrl: byId('xianyuUrl').value.trim(),
          wechatId: byId('wechatId').value.trim(),
          announcement: byId('announcement').value.trim(),
          features: {
            ...currentSiteSettings.features,
            trialVisits: byId('featureTrialVisits').checked,
            companionHall: byId('featureCompanionHall').checked,
            fishMode: byId('featureFishMode').checked,
            autoUpdates: byId('featureAutoUpdates').checked
          },
          defaults: {
            ...currentSiteSettings.defaults,
            personality: byId('defaultPersonality').value,
            interactionMode: byId('defaultInteractionMode').value,
            theaterIntervalSeconds: Number(byId('defaultTheaterInterval').value)
          },
          dailySummaries: dailySummaryPayload()
        }
      });
      fillSiteSettings(settings);
      showToast('远程配置已保存');
    });
  });

  for (const [key, description] of summaryPlaceholders) {
    const term = document.createElement('dt');
    const code = document.createElement('code');
    code.textContent = `{${key}}`;
    term.append(code);
    const definition = document.createElement('dd');
    definition.textContent = description;
    byId('dailySummaryPlaceholders').append(term, definition);
  }
  for (const id of [
    'dailySummariesEnabled', 'weeklySummaryEnabled', 'weeklySummaryWeekday',
    'weeklySummaryTime', 'monthlySummaryEnabled', 'monthlySummaryTime'
  ]) {
    byId(id).addEventListener('change', () => {
      markSummariesChanged();
      summaryPreviewRefreshers.forEach((refresh) => refresh());
    });
  }
  function addSummaryTemplate(kind) {
    if (summaryTemplates.length >= 40) return;
    const id = `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    summaryTemplates.push({ id, kind, enabled: true, title: '', body: '' });
    renderSummaryTemplates(id);
    markSummariesChanged();
  }
  bindClick('addWeeklySummaryTemplate', () => addSummaryTemplate('weekly'));
  bindClick('addMonthlySummaryTemplate', () => addSummaryTemplate('monthly'));

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
    id: 'settings',
    async load() {
      const [settings, releases] = await Promise.all([
        api('/api/admin/site-settings'),
        api('/api/admin/releases')
      ]);
      fillSiteSettings(settings);
      byId('adminUrl').value = releases.adminUrl || '';
      byId('manifestUrl').value = releases.manifestUrl || '';
    }
  };
});
