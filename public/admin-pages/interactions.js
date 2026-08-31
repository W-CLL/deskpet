registerAdminPage(function createInteractionsPage({ ui }) {
  const {
    byId, setText, bindClick, formatDate, cell, stackedCell, fillTable, createListView, loadJson
  } = ui;

  const modes = { quiet: '安静', standard: '标准', lively: '热闹' };

  const listView = createListView('interactions', {
    emptyElement: byId('emptyInteractions'),
    renderPage(accounts) {
      fillTable(byId('interactionRows'), accounts, (item) => [
        stackedCell('interaction-account', `账号 …${item.accountSuffix}`, `建档 ${formatDate(item.profile.createdAt)}`),
        stackedCell(
          'interaction-settings',
          `${modes[item.profile.mode] || item.profile.mode}模式`,
          item.profile.promptsEnabled ? '随机互动已开启' : '随机互动已关闭'
        ),
        cell('interaction-number', item.summary.totalInteractions),
        stackedCell(
          'interaction-detail',
          `共 ${item.summary.moodResponses} 次`,
          `开心 ${item.summary.moodHappy} · 一般 ${item.summary.moodOkay} · 低落 ${item.summary.moodLow}`
        ),
        stackedCell(
          'interaction-detail',
          `笑话 ${item.summary.jokesRevealed} · 答题 ${item.summary.quizzesAnswered}`,
          `答对 ${item.summary.quizzesCorrect} · 展示 ${item.summary.contentShown}`
        ),
        stackedCell(
          'date-stack',
          { text: item.summary.lastInteractionAt ? formatDate(item.summary.lastInteractionAt) : '尚无互动' }
        )
      ]);
    },
    matches: (item, filters) => (!filters.mode || item.profile.mode === filters.mode)
      && (!filters.enabled
        || (item.profile.promptsEnabled ? 'enabled' : 'disabled') === filters.enabled)
  });

  function renderInteractions(payload) {
    const summary = payload.summary || {};
    setText('interactionAccounts', summary.accounts || 0);
    setText('interactionActiveAccounts', summary.interactingAccounts || 0);
    setText('interactionTotal', summary.totalInteractions || 0);
    setText('interactionHappy', summary.moodHappy || 0);
    setText('interactionJokes', summary.jokesRevealed || 0);
    setText('interactionQuizzes', summary.quizzesAnswered || 0);
    listView.setItems(payload.accounts);
  }

  async function loadInteractions() {
    await loadJson('/api/admin/interactions', renderInteractions, byId('refreshInteractionButton'));
  }

  bindClick('refreshInteractionButton', loadInteractions);
  return { load: loadInteractions };
});
