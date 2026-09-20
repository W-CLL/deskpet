/**
 * Assemble public/admin/index.html from shell + legacy page panels.
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const legacyHtml = fs.readFileSync(path.join(root, 'public', 'admin.html'), 'utf8');
const outPath = path.join(root, 'public', 'admin', 'index.html');

function extractPanel(name) {
  const re = new RegExp(
    `<section class="admin-page" data-page-panel="${name}"[^>]*>([\\s\\S]*?)<\\/section>\\s*(?=<section class="admin-page"|<\\/div>\\s*<\\/div>\\s*<\\/div>\\s*<\\/main>)`,
    'm'
  );
  const match = legacyHtml.match(re);
  if (!match) throw new Error(`missing panel ${name}`);
  return match[1].trim();
}

const pages = [
  'overview', 'android', 'releases', 'activations', 'interactions',
  'companions', 'analytics', 'content', 'resource-packs', 'visit-stickers', 'feedback'
];

// Build settings panel from overview remote-config pieces + address fields
const settingsPanel = `
<section class="admin-page" data-page-panel="settings">
  <div class="settings-grid">
    <section class="card settings-card">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">接入</p>
          <h2>域名接入地址</h2>
        </div>
      </div>
      <div class="address-field">
        <span>管理后台</span>
        <span class="copy-row">
          <input id="adminUrl" aria-label="管理后台地址" readonly>
          <button id="copyAdminUrlButton" class="button button-secondary" type="button">复制</button>
        </span>
      </div>
      <div class="address-field">
        <span>更新清单</span>
        <span class="copy-row">
          <input id="manifestUrl" aria-label="更新清单地址" readonly>
          <button id="copyManifestButton" class="button button-secondary" type="button">复制</button>
        </span>
      </div>
    </section>

    <form id="siteSettingsForm" class="card settings-card">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">对外</p>
          <h2>联系与公告</h2>
        </div>
      </div>
      <div class="address-field">
        <label for="xianyuUrl">官网闲鱼交易链接</label>
        <input id="xianyuUrl" type="url" inputmode="url" maxlength="500" placeholder="https://www.goofish.com/...">
      </div>
      <div class="address-field">
        <label for="wechatId">客服微信号</label>
        <input id="wechatId" type="text" maxlength="32" placeholder="wcl_lcw627" autocomplete="off">
      </div>
      <div class="address-field">
        <label for="announcement">客户端公告（可空）</label>
        <input id="announcement" type="text" maxlength="120" placeholder="只显示给已安装的客户端">
      </div>
    </form>

    <section class="card settings-card">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">开关</p>
          <h2>远程功能</h2>
        </div>
      </div>
      <fieldset class="remote-flags" form="siteSettingsForm">
        <legend>客户端可远程关闭的能力</legend>
        <label><input id="featureTrialVisits" type="checkbox" form="siteSettingsForm"> 体验来访</label>
        <label><input id="featureCompanionHall" type="checkbox" form="siteSettingsForm"> 搭子大厅</label>
        <label><input id="featureFishMode" type="checkbox" form="siteSettingsForm"> 摸鱼广告</label>
        <label><input id="featureAutoUpdates" type="checkbox" form="siteSettingsForm"> 自动检查更新</label>
      </fieldset>
    </section>

    <section class="card settings-card">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">默认值</p>
          <h2>新安装默认配置</h2>
        </div>
      </div>
      <div class="remote-defaults">
        <label for="defaultPersonality">默认性格</label>
        <select id="defaultPersonality" form="siteSettingsForm">
          <option value="lively">活泼</option>
          <option value="shy">害羞</option>
          <option value="clingy">黏人</option>
          <option value="chaotic">混乱</option>
        </select>
        <label for="defaultInteractionMode">默认互动</label>
        <select id="defaultInteractionMode" form="siteSettingsForm">
          <option value="quiet">安静</option>
          <option value="standard">标准</option>
          <option value="lively">热闹</option>
        </select>
        <label for="defaultTheaterInterval">默认剧场间隔</label>
        <select id="defaultTheaterInterval" form="siteSettingsForm">
          <option value="60">1 分钟</option>
          <option value="180">3 分钟</option>
          <option value="300">5 分钟</option>
          <option value="600">10 分钟</option>
          <option value="1800">30 分钟</option>
        </select>
      </div>
    </section>

    <div class="settings-actions">
      <button id="saveSiteSettingsButton" class="button button-primary" type="submit" form="siteSettingsForm">保存远程配置</button>
    </div>
  </div>
</section>
`.trim();

function cleanOverview(panelHtml) {
  // Remove embedded site settings form / address list workbench left column complexity
  // Replace overview-workbench with new dashboard mounts
  return `
<div class="kpi-grid" id="overviewKpiGrid" aria-label="运营概览"></div>

<div class="overview-workbench">
  <section class="card">
    <div class="panel-heading">
      <div>
        <p class="eyebrow">内容健康度</p>
        <h2>词库库存</h2>
      </div>
    </div>
    <div class="stock-bars" id="overviewContentStock"></div>
  </section>

  <section class="quick-section">
    <div class="panel-heading">
      <p class="eyebrow">今天先看</p>
      <h2>待办</h2>
    </div>
    <div class="quick-grid" id="overviewTodoList"></div>
  </section>
</div>

<section class="card">
  <div class="panel-heading">
    <div>
      <p class="eyebrow">运维</p>
      <h2>当前发布版本</h2>
    </div>
  </div>
  <div class="summary-strip" id="overviewReleaseStrip" aria-label="各端当前版本"></div>
</section>
`.trim();
}

const panelHtml = {};
for (const name of pages) {
  if (name === 'overview') {
    panelHtml[name] = cleanOverview(extractPanel('overview'));
  } else {
    let html = extractPanel(name);
    panelHtml[name] = html;
  }
}

const html = `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <title>桌搭子管理后台</title>
  <link rel="icon" href="/assets/app-icon.png">
  <script src="/assets/admin/js/core/theme.js?v=admin-theme-1"></script>
  <link rel="stylesheet" href="/assets/admin/css/tokens.css?v=admin-v2">
  <link rel="stylesheet" href="/assets/admin/css/base.css?v=admin-v2">
  <link rel="stylesheet" href="/assets/admin/css/layout.css?v=admin-v2">
  <link rel="stylesheet" href="/assets/admin/css/pages.css?v=admin-v2">
</head>
<body>
  <main class="app-root">
    <section id="loginView" class="login-view">
      <div class="login-hero">
        <div class="login-brand">
          <img src="/assets/app-icon.png" width="44" height="44" alt="">
          <div>
            <strong>桌搭子</strong>
            <span>Update & Ops Console</span>
          </div>
        </div>
        <h1>把发布、授权、内容和反馈放在同一处处理</h1>
        <p>浅色现代后台，强调有用的运营指标、清晰的表格操作，以及独立的系统设置。</p>
        <ul>
          <li>近 7 日访问 / 下载 / 授权概况</li>
          <li>内容库存与启用率</li>
          <li>版本、反馈、搭子待办</li>
        </ul>
      </div>
      <div class="login-side">
        <form id="loginForm" class="login-panel">
          <div class="section-heading login-heading">
            <p class="eyebrow">安全访问</p>
            <h1>登录管理后台</h1>
          </div>
          <label>
            <span>用户名</span>
            <input name="username" autocomplete="username" required>
          </label>
          <label>
            <span>密码</span>
            <input name="password" type="password" autocomplete="current-password" required autofocus>
          </label>
          <p id="loginError" class="form-error" role="alert"></p>
          <button class="button button-primary button-block" type="submit">登录</button>
        </form>
      </div>
    </section>

    <div id="adminView" class="admin-shell" hidden>
      <aside class="sidebar">
        <div class="sidebar-brand">
          <img src="/assets/app-icon.png" width="36" height="36" alt="">
          <div>
            <strong>桌搭子</strong>
            <span>管理后台</span>
          </div>
        </div>

        <nav class="sidebar-nav" aria-label="后台导航">
          <div class="nav-group">
            <p class="sidebar-label">总览</p>
            <button class="nav-item" type="button" data-page="overview" aria-current="page">
              <span>概览</span>
              <small>运营与健康度</small>
            </button>
          </div>
          <div class="nav-group">
            <p class="sidebar-label">发布与授权</p>
            <button class="nav-item" type="button" data-page="releases"><span>版本发布</span><small>安装包与清单</small></button>
            <button class="nav-item" type="button" data-page="android"><span>Android</span><small>APK 与设备</small></button>
            <button class="nav-item" type="button" data-page="activations"><span>激活授权</span><small>激活码与设备</small></button>
          </div>
          <div class="nav-group">
            <p class="sidebar-label">运营数据</p>
            <button class="nav-item" type="button" data-page="analytics"><span>增长数据</span><small>访问下载留存</small></button>
            <button class="nav-item" type="button" data-page="interactions"><span>互动统计</span><small>账号行为</small></button>
            <button class="nav-item" type="button" data-page="companions"><span>搭子联机</span><small>配对与投递</small></button>
          </div>
          <div class="nav-group">
            <p class="sidebar-label">内容运营</p>
            <button class="nav-item" type="button" data-page="content"><span>内容库</span><small>六类互动内容</small></button>
            <button class="nav-item" type="button" data-page="resource-packs"><span>资源包</span><small>词包与小剧场</small></button>
            <button class="nav-item" type="button" data-page="visit-stickers"><span>体验来访</span><small>表情包</small></button>
          </div>
          <div class="nav-group">
            <p class="sidebar-label">支持与设置</p>
            <button class="nav-item" type="button" data-page="feedback"><span>问题反馈</span><small>问题与建议</small></button>
            <button class="nav-item" type="button" data-page="settings"><span>系统设置</span><small>远程配置</small></button>
          </div>
        </nav>

        <div class="sidebar-status">
          <span class="status-dot" aria-hidden="true"></span>
          <div>
            <strong id="connectionStatus">管理服务正常</strong>
            <span>安全会话已建立</span>
          </div>
        </div>
      </aside>

      <div class="admin-content">
        <header class="content-header">
          <div class="header-title">
            <span class="header-kicker">管理工作区</span>
            <h1 id="pageTitle">概览</h1>
            <p id="pageSubtitle">今天先处理这些</p>
          </div>
          <div class="header-actions">
            <button id="themeToggleButton" class="button button-secondary" type="button" title="切换到浅色主题">浅色</button>
            <button id="refreshPageButton" class="button button-secondary" type="button">刷新</button>
            <button id="logoutButton" class="button button-secondary" type="button">退出</button>
          </div>
        </header>

        <div class="page-body">
${pages.map((name) => {
  const hidden = name === 'overview' ? '' : ' hidden';
  return `          <section class="admin-page" data-page-panel="${name}"${hidden}>\n${panelHtml[name]}\n          </section>`;
}).join('\n\n')}

          ${settingsPanel.replace('<section class="admin-page" data-page-panel="settings">', '<section class="admin-page" data-page-panel="settings" hidden>')}
        </div>
      </div>
    </div>
  </main>

  <div id="drawerBackdrop" class="drawer-backdrop" hidden></div>
  <aside id="editorDrawer" class="drawer" hidden>
    <div class="drawer-header">
      <div>
        <p class="eyebrow" id="drawerEyebrow">编辑</p>
        <h2 id="drawerTitle">编辑</h2>
      </div>
      <button id="drawerCloseButton" class="button button-ghost" type="button">关闭</button>
    </div>
    <div class="drawer-body" id="drawerBody"></div>
    <div class="drawer-footer" id="drawerFooter"></div>
  </aside>

  <dialog id="confirmDialog">
    <form method="dialog">
      <h2 id="confirmTitle">确认操作</h2>
      <p id="confirmMessage"></p>
      <div class="dialog-actions">
        <button class="button button-secondary" value="cancel">取消</button>
        <button id="confirmButton" class="button button-primary" value="confirm">确认</button>
      </div>
    </form>
  </dialog>

  <dialog id="generatedCodesDialog" class="codes-dialog">
    <form method="dialog">
      <h2>激活码已生成</h2>
      <p>完整激活码也可以稍后在管理列表中查看和复制。</p>
      <textarea id="generatedCodesText" readonly rows="8"></textarea>
      <div class="dialog-actions">
        <button id="copyGeneratedCodesButton" class="button button-secondary" type="button">复制全部</button>
        <button class="button button-primary" value="close">完成</button>
      </div>
    </form>
  </dialog>

  <div id="toast" class="toast" role="status" aria-live="polite" hidden></div>

  <script src="/assets/admin/js/core/api.js?v=admin-v2"></script>
  <script src="/assets/admin/js/core/ui.js?v=admin-v2"></script>
  <script src="/assets/admin/js/core/list-view.js?v=admin-v2"></script>
  <script src="/assets/admin/js/core/stats.js?v=admin-v2"></script>
  <script src="/assets/admin/js/core/form-kit.js?v=admin-v2"></script>
  <script src="/assets/admin/js/core/router.js?v=admin-v2"></script>
  <script src="/assets/admin/js/pages/overview.js?v=admin-v2"></script>
  <script src="/assets/admin/js/pages/settings.js?v=admin-v2"></script>
  <script src="/assets/admin/js/pages/releases.js?v=admin-v2"></script>
  <script src="/assets/admin/js/pages/resource-packs.js?v=admin-v2"></script>
  <script src="/assets/admin/js/pages/visit-stickers.js?v=admin-v2"></script>
  <script src="/assets/admin/js/pages/activations.js?v=admin-v2"></script>
  <script src="/assets/admin/js/pages/interactions.js?v=admin-v2"></script>
  <script src="/assets/admin/js/pages/companions.js?v=admin-v2"></script>
  <script src="/assets/admin/js/pages/analytics.js?v=admin-v2"></script>
  <script src="/assets/admin/js/pages/content.js?v=admin-v2"></script>
  <script src="/assets/admin/js/pages/feedback.js?v=admin-v2"></script>
  <script src="/assets/admin/js/main.js?v=admin-theme-1"></script>
</body>
</html>
`;

fs.writeFileSync(outPath, html, 'utf8');
console.log('wrote', outPath, 'bytes', Buffer.byteLength(html));
