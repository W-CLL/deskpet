/**
 * Wrap multi-table sections into data-subpanel blocks for secondary nav.
 */
const fs = require('node:fs');
const path = require('node:path');

const filePath = path.join(__dirname, '..', 'public', 'admin', 'index.html');
let html = fs.readFileSync(filePath, 'utf8');

function replaceOnce(source, startMarker, endMarker, replacer) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`markers not found: ${startMarker}`);
  return source.slice(0, start) + replacer(source.slice(start, end)) + source.slice(end);
}

// --- Companions ---
html = replaceOnce(
  html,
  '<section class="admin-page" data-page-panel="companions" hidden>',
  '<section class="admin-page" data-page-panel="analytics" hidden>',
  (block) => {
    // Split inside companion-section
    let body = block;
    // After metrics + before send form = overview start already there
    // Wrap: metrics+send+daily table as overview
    // pairs, profiles, deliveries as separate subpanels

    body = body.replace(
      /(<section class="tool-panel companion-section">)([\s\S]*?)(<form id="companionSendForm")/,
      `$1
              <div class="page-subpanel" data-subpanel="overview">
              $2
              $3`
    );

    // Close overview before pairs heading, open pairs
    body = body.replace(
      /(<div class="panel-heading companion-history-heading"><div><p class="eyebrow">当前关系<\/p><h2>谁和谁绑定<\/h2><\/div><\/div>)/,
      `</div>
              <div class="page-subpanel" data-subpanel="pairs" hidden>
              $1`
    );

    body = body.replace(
      /(<div class="panel-heading companion-history-heading"><div><p class="eyebrow">账号状态<\/p><h2>联机档案明细<\/h2><\/div><\/div>)/,
      `</div>
              <div class="page-subpanel" data-subpanel="profiles" hidden>
              $1`
    );

    body = body.replace(
      /(<div class="panel-heading companion-history-heading"><div><p class="eyebrow">最近 200 条<\/p><h2>投递明细<\/h2><\/div><\/div>)/,
      `</div>
              <div class="page-subpanel" data-subpanel="deliveries" hidden>
              $1`
    );

    // Close last subpanel before closing companion-section
    body = body.replace(
      /(data-list-pagination="companion-deliveries"><\/div>\s*)(<\/section>\s*<\/section>)/,
      `$1</div>\n            $2`
    );
    return body;
  }
);

// --- Analytics ---
html = replaceOnce(
  html,
  '<section class="admin-page" data-page-panel="analytics" hidden>',
  '<section class="admin-page" data-page-panel="content" hidden>',
  (block) => {
    let body = block;

    // overview: heading + metrics
    body = body.replace(
      /(<section class="tool-panel analytics-section">)([\s\S]*?)(<div class="panel-heading usage-heading">\s*<div><p class="eyebrow">实际文件传输<\/p><h2>版本下载次数<\/h2><\/div>)/,
      `$1
              <div class="page-subpanel" data-subpanel="overview">
              $2
              </div>
              <div class="page-subpanel" data-subpanel="downloads" hidden>
              $3`
    );

    body = body.replace(
      /(<div class="panel-heading usage-heading">\s*<div><p class="eyebrow">接口心跳<\/p><h2>设备在线与活跃明细<\/h2><\/div>\s*<\/div>)/,
      `</div>
              <div class="page-subpanel" data-subpanel="devices" hidden>
              $1`
    );

    body = body.replace(
      /(<div class="analytics-tables usage-tables">)/,
      `</div>
              <div class="page-subpanel" data-subpanel="features" hidden>
              $1`
    );

    // Split features/api - currently in one analytics-tables. Keep both in features panel for now,
    // and put platforms+cohorts in retention panel.
    body = body.replace(
      /(<div class="analytics-tables">\s*<div class="table-wrap">\s*<table>\s*<thead><tr><th>平台<\/th>)/,
      `</div>
              <div class="page-subpanel" data-subpanel="retention" hidden>
              $1`
    );

    body = body.replace(
      /(<p id="analyticsEmpty" class="empty-state" hidden>当前区间暂无增长数据<\/p>\s*)(<\/section>\s*<\/section>)/,
      `$1</div>\n            $2`
    );
    return body;
  }
);

// --- Android: split release status / devices ---
html = replaceOnce(
  html,
  '<section class="admin-page" data-page-panel="android" hidden>',
  '<section class="admin-page" data-page-panel="releases" hidden>',
  (block) => {
    let body = block;
    // Find android-workbench children
    body = body.replace(
      /(<div class="android-workbench">\s*)(<section class="tool-panel android-release-panel">)/,
      `$1<div class="page-subpanel" data-subpanel="packages">$2`
    );
    body = body.replace(
      /(<\/section>\s*)(<section class="tool-panel android-device-panel">)/,
      `$1</div>\n              <div class="page-subpanel" data-subpanel="devices" hidden>$2`
    );
    body = body.replace(
      /(data-list-pagination="android-devices"><\/div>\s*<\/section>\s*)(<\/div>\s*<\/section>)/,
      `$1</div>\n            $2`
    );
    return body;
  }
);

// --- Content: list vs import ---
html = replaceOnce(
  html,
  '<section class="admin-page" data-page-panel="content" hidden>',
  '<section class="admin-page" data-page-panel="resource-packs" hidden>',
  (block) => {
    let body = block;
    // Put summary + list/bulk as list; import form as import subpanel
    body = body.replace(
      /(<section class="content-section">)/,
      `$1\n              <div class="page-subpanel" data-subpanel="list">`
    );
    // Find import form - contentImportForm
    if (body.includes('contentImportForm')) {
      body = body.replace(
        /(<form id="contentImportForm")/,
        `</div>\n              <div class="page-subpanel" data-subpanel="import" hidden>\n              $1`
      );
      body = body.replace(
        /(<\/form>\s*)(<\/section>\s*<\/section>)/,
        `$1</div>\n            $2`
      );
    } else {
      // close list before end
      body = body.replace(
        /(data-list-pagination="content"><\/div>\s*)([\s\S]*?)(<\/section>\s*<\/section>)/,
        `$1$2</div>\n            $3`
      );
    }
    return body;
  }
);

fs.writeFileSync(filePath, html);
console.log('subpanels patched');
