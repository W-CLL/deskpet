registerAdminPage(function createOverviewPage({ ui, api, navigateTo }) {
  const { byId, loadJson } = ui;

  const typeLabels = {
    joke: '冷笑话',
    math: '数学题',
    trivia: '趣味知识',
    riddle: '脑筋急转弯',
    tip: '小贴士',
    care: '关怀'
  };

  function kpiCard({ label, value, hint, tone = 'brand', wide = false }) {
    const card = document.createElement('article');
    card.className = `kpi-card${wide ? ' kpi-wide' : ''}`;
    card.dataset.tone = tone;
    const span = document.createElement('span');
    span.textContent = label;
    const strong = document.createElement('strong');
    strong.textContent = value;
    const small = document.createElement('small');
    small.textContent = hint;
    card.append(span, strong, small);
    return card;
  }

  function renderKpis(payload) {
    const grid = byId('overviewKpiGrid');
    if (!grid) return;
    const { ops, content, tech } = payload;
    const clickRate = Number(ops.clickRate7d || 0);
    grid.replaceChildren(
      kpiCard({
        label: '近 7 日访问',
        value: String(ops.pageViews7d || 0),
        hint: `独立访客 ${ops.uniqueVisitors7d || 0}`,
        tone: 'info'
      }),
      kpiCard({
        label: '近 7 日下载点击',
        value: String(ops.downloadClicks7d || 0),
        hint: `点击率 ${(clickRate * 100).toFixed(1)}%`,
        tone: 'brand'
      }),
      kpiCard({
        label: '有效授权',
        value: String(ops.activeLicenses || 0),
        hint: `未使用激活码 ${ops.unusedCodes || 0}`,
        tone: 'brand'
      }),
      kpiCard({
        label: '待处理反馈',
        value: String(ops.pendingFeedback || 0),
        hint: ops.pendingFeedback ? '需要尽快处理' : '暂无积压',
        tone: ops.pendingFeedback ? 'danger' : 'brand'
      }),
      kpiCard({
        label: '内容启用率',
        value: `${content.activeRate || 0}%`,
        hint: `启用 ${content.active || 0} / 总计 ${content.total || 0}`,
        tone: 'violet'
      }),
      kpiCard({
        label: '在线设备',
        value: String(tech.onlineDevices || 0),
        hint: `授权设备 ${tech.activeAuthorizedDevices || 0} · 7 日不活跃 ${tech.inactive7Days || 0}`,
        tone: 'info'
      }),
      kpiCard({
        label: '资源包',
        value: String(content.resourcePacks?.total || 0),
        hint: `词包 ${content.resourcePacks?.words || 0} · 小剧场 ${content.resourcePacks?.theater || 0}`,
        tone: 'warning'
      }),
      kpiCard({
        label: '内容目录',
        value: `v${content.catalogVersion || 0}`,
        hint: `草稿版本 ${tech.releaseCounts?.drafts || 0} · 已发布 ${tech.releaseCounts?.published || 0}`,
        tone: 'brand'
      })
    );
  }

  function renderStock(payload) {
    const host = byId('overviewContentStock');
    if (!host) return;
    const byType = payload.content.byType || {};
    const max = Math.max(1, ...Object.values(byType).map((value) => Number(value) || 0));
    host.replaceChildren(...Object.entries(typeLabels).map(([key, label]) => {
      const count = Number(byType[key] || 0);
      const row = document.createElement('div');
      row.className = 'stock-row';
      const name = document.createElement('span');
      name.textContent = label;
      const track = document.createElement('div');
      track.className = 'stock-track';
      const fill = document.createElement('div');
      fill.className = 'stock-fill';
      fill.style.width = `${Math.round((count / max) * 100)}%`;
      track.append(fill);
      const value = document.createElement('strong');
      value.textContent = String(count);
      row.append(name, track, value);
      return row;
    }));
  }

  function renderTodos(payload) {
    const host = byId('overviewTodoList');
    if (!host) return;
    host.replaceChildren(...(payload.todos || []).map((item) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'quick-action';
      button.dataset.goTo = item.page;
      const title = document.createElement('strong');
      title.textContent = item.title;
      const detail = document.createElement('span');
      detail.textContent = item.detail;
      button.append(title, detail);
      button.addEventListener('click', () => navigateTo(item.page));
      return button;
    }));
  }

  function renderReleases(payload) {
    const host = byId('overviewReleaseStrip');
    if (!host) return;
    const versions = payload.tech.activeVersions || {};
    const entries = Object.entries(versions);
    if (!entries.length) {
      host.replaceChildren((() => {
        const item = document.createElement('span');
        item.className = 'summary-item';
        item.innerHTML = '当前发布 <strong>尚未发布</strong>';
        return item;
      })());
      return;
    }
    host.replaceChildren(...entries.map(([key, version]) => {
      const item = document.createElement('span');
      item.className = 'summary-item';
      item.dataset.tone = 'info';
      item.append(
        document.createTextNode(key),
        Object.assign(document.createElement('strong'), { textContent: `v${version}` })
      );
      return item;
    }));
  }

  function renderOverview(payload) {
    renderKpis(payload);
    renderStock(payload);
    renderTodos(payload);
    renderReleases(payload);
  }

  return {
    id: 'overview',
    load() {
      return loadJson('/api/admin/overview', renderOverview, byId('refreshPageButton'));
    }
  };
});
