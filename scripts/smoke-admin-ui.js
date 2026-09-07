async function main() {
  const admin = await fetch('http://127.0.0.1:3100/admin');
  const html = await admin.text();
  const css = await fetch('http://127.0.0.1:3100/assets/admin/css/layout.css');
  const js = await fetch('http://127.0.0.1:3100/assets/admin/js/main.js');
  const session = await (await fetch('http://127.0.0.1:3100/api/admin/session')).json();
  console.log({
    admin: admin.status,
    htmlHasOverview: html.includes('overviewKpiGrid'),
    htmlHasSettings: html.includes('data-page-panel="settings"'),
    css: css.status,
    js: js.status,
    session
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
