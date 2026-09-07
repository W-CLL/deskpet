const fs = require('node:fs');
const path = require('node:path');

const filePath = path.join(__dirname, '..', 'public', 'admin', 'index.html');
let html = fs.readFileSync(filePath, 'utf8');

const headInjection = `<meta name="color-scheme" content="dark light">
  <title>桌搭子管理后台</title>
  <link rel="icon" href="/assets/app-icon.png">
  <script>
    (function () {
      try {
        var saved = localStorage.getItem('deskpet-admin-theme');
        document.documentElement.setAttribute('data-theme', saved === 'light' ? 'light' : 'dark');
      } catch (error) {
        document.documentElement.setAttribute('data-theme', 'dark');
      }
    })();
  </script>
  <link rel="stylesheet" href="/assets/admin/css/tokens.css?v=admin-v3-dark">
  <link rel="stylesheet" href="/assets/admin/css/base.css?v=admin-v3-dark">
  <link rel="stylesheet" href="/assets/admin/css/layout.css?v=admin-v3-dark">
  <link rel="stylesheet" href="/assets/admin/css/pages.css?v=admin-v3-dark">
</head>`;

html = html.replace(
  /<meta name="color-scheme"[\s\S]*?<\/head>/,
  headInjection
);

html = html.replaceAll('??v=', '?v=');
html = html.replaceAll(/[?]v=admin-v3-[a-z]+/g, '?v=admin-v3-dark');

if (!html.includes('id="themeToggleButton"')) {
  html = html.replace(
    '<button id="refreshPageButton"',
    '<button id="themeToggleButton" class="button button-secondary" type="button" title="切换主题">浅色</button>\n            <button id="refreshPageButton"'
  );
}

fs.writeFileSync(filePath, html);
console.log('fixed head');
console.log(html.slice(html.indexOf('<head>'), html.indexOf('</head>') + 7));
