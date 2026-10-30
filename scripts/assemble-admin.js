/**
 * Validate the canonical admin page without regenerating it from legacy HTML.
 *
 * public/admin/index.html owns the current forms, drawers and route structure.
 * public/admin.html is historical and must never overwrite the canonical page.
 */
const fs = require('node:fs');
const path = require('node:path');

const requiredIds = [
  'loginForm', 'loginView', 'adminView', 'loginError', 'themeToggleButton',
  'sidebarToggleButton', 'sidebarCloseButton', 'sidebarBackdrop',
  'editorDrawer', 'drawerBody', 'drawerFooter', 'uploadForm', 'releaseNotesEditorForm',
  'siteSettingsForm', 'activationQrFile', 'activationQrPreview',
  'dailySummaryTemplates', 'weeklySummaryTime', 'monthlySummaryTime',
  'resourcePackForm', 'resourcePackVersion', 'resourcePackStatus', 'resourcePackFormError',
  'petMarketRoot', 'petMarketOrdersRoot', 'uninstallsRoot'
];
const requiredRoutes = [
  'overview', 'releases', 'android/packages', 'android/devices', 'activations',
  'analytics/overview', 'analytics/downloads', 'analytics/devices',
  'analytics/features', 'analytics/retention', 'interactions',
  'companions/overview', 'companions/pairs', 'companions/profiles', 'companions/deliveries',
  'content', 'resource-packs', 'pet-market', 'pet-market-orders', 'visit-stickers',
  'feedback', 'uninstalls', 'settings'
];
const requiredScripts = [
  'core/theme.js', 'core/ui.js', 'core/form-kit.js',
  'pages/overview.js', 'pages/settings.js', 'pages/releases.js',
  'pages/resource-packs.js', 'pages/pet-market.js', 'pages/pet-market-orders.js',
  'pages/visit-stickers.js', 'pages/activations.js', 'pages/interactions.js',
  'pages/companions.js', 'pages/analytics.js', 'pages/content.js',
  'pages/feedback.js', 'pages/uninstalls.js', 'main.js'
];

function validateAdminPage(html) {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const uniqueIds = new Set(ids);
  const errors = [];
  for (const id of new Set(ids.filter((value, index) => ids.indexOf(value) !== index))) {
    errors.push(`duplicate id: ${id}`);
  }
  for (const id of requiredIds) {
    if (!uniqueIds.has(id)) errors.push(`missing element: ${id}`);
  }
  const routes = new Set([...html.matchAll(/\bdata-route="([^"]+)"/g)].map((match) => match[1]));
  const panels = new Set([...html.matchAll(/\bdata-page-panel="([^"]+)"/g)].map((match) => match[1]));
  for (const route of requiredRoutes) {
    if (!routes.has(route)) errors.push(`missing navigation route: ${route}`);
    const page = route.split('/')[0];
    if (!panels.has(page)) errors.push(`missing page panel: ${page}`);
  }
  const scripts = [...html.matchAll(/<script\b[^>]*src="([^"?]+)(?:\?[^"]*)?"[^>]*>/g)]
    .map((match) => match[1].replace('/assets/admin/js/', ''));
  for (const script of requiredScripts) {
    if (scripts.filter((value) => value === script).length !== 1) {
      errors.push(`expected exactly one script: ${script}`);
    }
  }
  if (scripts.at(-1) !== 'main.js') errors.push('main.js must load after all page factories');
  if (errors.length) throw new Error(`Canonical admin page is incomplete:\n${errors.join('\n')}`);
  return { elements: uniqueIds.size, routes: routes.size, scripts: scripts.length };
}

if (require.main === module) {
  const canonicalPath = path.join(__dirname, '..', 'public', 'admin', 'index.html');
  if (!fs.existsSync(canonicalPath)) {
    throw new Error('Missing canonical public/admin/index.html; restore it from version control. Legacy public/admin.html is not a valid source.');
  }
  const result = validateAdminPage(fs.readFileSync(canonicalPath, 'utf8'));
  console.log(`Validated canonical admin page (${result.elements} elements, ${result.routes} routes); no files rewritten.`);
}

module.exports = { validateAdminPage };
