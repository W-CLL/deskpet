registerAdminPage(function createActivationsPage({ ui, api, showToast, confirmAction, navigateTo }) {
  const {
    byId, setText, bindClick, bindSubmit, formatDate, cell, actionButton, stackedCell,
    badgeCell, actionsCell, fillTable, createListView, loadJson, copyText, withBusy
  } = ui;

  const activationStatus = {
    unused: ['未使用', ''],
    expired: ['已过期', 'expired'],
    used: ['已使用', 'active'],
    revoked: ['已撤销', 'revoked']
  };

  function activationStatusKey(item) {
    return item.license?.status === 'revoked' ? 'revoked' : item.status;
  }

  async function getActivationCode(item) {
    const payload = await api(`/api/admin/activation-codes/${encodeURIComponent(item.id)}/reveal`, { method: 'POST' });
    return payload.code;
  }

  async function revokeLicense(item) {
    const confirmed = await confirmAction({
      title: `撤销授权 ${item.maskedCode}`,
      message: '撤销后，该设备仍可运行桌搭子，但不能再检查或下载更新。',
      confirmLabel: '撤销授权',
      danger: true
    });
    if (!confirmed) return;
    try {
      await api(`/api/admin/licenses/${encodeURIComponent(item.license.id)}/revoke`, { method: 'POST' });
      showToast('设备授权已撤销');
      await loadActivations();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function createRebindCode(item) {
    const confirmed = await confirmAction({
      title: `生成账号 …${item.account.suffix} 的换机码`,
      message: '换机码在新设备成功绑定后才会撤销原设备授权，有效期为 24 小时。',
      confirmLabel: '生成换机码'
    });
    if (!confirmed) return;
    try {
      const generated = await api(
        `/api/admin/accounts/${encodeURIComponent(item.account.id)}/rebind-code`,
        { method: 'POST', body: { expiresInHours: 24 } }
      );
      byId('generatedCodesText').value = generated.code;
      byId('generatedCodesDialog').showModal();
      await loadActivations();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  const androidListView = createListView('android-devices', {
    emptyElement: byId('emptyAndroidDevices'),
    renderPage(devices) {
      fillTable(byId('androidDeviceRows'), devices, (item) => {
        const active = item.license.status === 'active';
        return [
          stackedCell(
            'license-cell',
            `设备 …${item.license.installationSuffix}`,
            item.account ? `账号 …${item.account.suffix}` : '账号 -'
          ),
          cell('', `v${item.license.appVersion || '-'}`),
          cell('', item.license.architecture || 'unknown'),
          badgeCell(active ? '有效' : '已撤销', active ? 'active' : 'revoked'),
          cell('', item.license.lastUpdateAt ? formatDate(item.license.lastUpdateAt) : '尚未检查更新')
        ];
      });
    },
    matches: (item, filters) => (!filters.architecture || item.license.architecture === filters.architecture)
      && (!filters.status || item.license.status === filters.status),
    searchPlaceholder: '搜索设备、账号或版本',
    searchText: (item) => [
      item.license?.installationSuffix,
      item.account?.suffix,
      item.license?.appVersion,
      item.license?.architecture,
      item.license?.status
    ]
  });

  function renderAndroidDevices(codes) {
    const androidDevices = codes
      .flatMap((item) => (item.licenses || (item.license ? [item.license] : []))
        .filter((license) => license.platform === 'android')
        .map((license) => ({ ...item, license })));
    androidListView.setItems(androidDevices);
  }

  const listView = createListView('activations', {
    emptyElement: byId('emptyActivations'),
    renderPage(codes) {
      const accountsWithRebindAction = new Set();
      fillTable(byId('activationRows'), codes, (item) => {
        const codeCell = stackedCell(
          'activation-code',
          item.maskedCode,
          item.purpose === 'rebind' && { text: '换机码' },
          !item.canReveal && { text: '旧码无法恢复' }
        );
        const code = codeCell.querySelector('strong');
        const [statusLabel, statusClass] = activationStatus[activationStatusKey(item)] || ['未知', ''];
        const licenses = item.licenses?.length ? item.licenses : (item.license ? [item.license] : []);
        const licenseParts = [];
        if (item.account) licenseParts.push(`账号 …${item.account.suffix}`);
        for (const license of licenses) {
          const platform = { windows: 'Windows', macos: 'macOS', android: 'Android' }[license.platform] || '未知平台';
          const statusHint = license.status === 'active' ? '' : ' · 已撤销';
          const checkedAt = license.lastUpdateAt ? formatDate(license.lastUpdateAt) : '尚未检查更新';
          licenseParts.push(
            { text: `设备 …${license.installationSuffix} · ${platform} / ${license.architecture || 'unknown'}${statusHint}` },
            { text: `v${license.appVersion || '-'} · ${checkedAt}` }
          );
        }
        const licenseCell = licenseParts.length
          ? stackedCell('license-cell', ...licenseParts)
          : cell('license-cell', '-');

        const actionNodes = [];
        if (item.canReveal) {
          let revealedCode = '';
          const viewButton = actionButton('查看', 'button-secondary', async () => {
            if (revealedCode && code.textContent === revealedCode) {
              code.textContent = item.maskedCode;
              viewButton.textContent = '查看';
              return;
            }
            viewButton.disabled = true;
            try {
              revealedCode = revealedCode || await getActivationCode(item);
              code.textContent = revealedCode;
              viewButton.textContent = '隐藏';
            } catch (error) {
              showToast(error.message, 'error');
            } finally {
              viewButton.disabled = false;
            }
          });
          const copyButton = actionButton('复制', 'button-secondary', async () => {
            copyButton.disabled = true;
            try {
              revealedCode = revealedCode || await getActivationCode(item);
              await navigator.clipboard.writeText(revealedCode);
              showToast('激活码已复制');
            } catch (error) {
              showToast(error.message || '复制失败', 'error');
            } finally {
              copyButton.disabled = false;
            }
          });
          actionNodes.push(viewButton, copyButton);
        }
        const activeLicenses = licenses.filter((license) => license.status === 'active');
        for (const license of activeLicenses) {
          actionNodes.push(actionButton(
            activeLicenses.length > 1 ? `撤销 …${license.installationSuffix}` : '撤销',
            'button-danger',
            () => revokeLicense({ ...item, license })
          ));
        }
        if (item.account?.status === 'active' && !accountsWithRebindAction.has(item.account.id)) {
          actionNodes.push(actionButton('换机码', 'button-secondary', () => createRebindCode(item)));
          accountsWithRebindAction.add(item.account.id);
        }

        return [
          codeCell,
          badgeCell(statusLabel, statusClass),
          cell('', item.note || '-'),
          stackedCell('date-stack', { text: `生成 ${formatDate(item.createdAt)}` }, { text: `到期 ${formatDate(item.expiresAt)}` }),
          licenseCell,
          actionsCell(...actionNodes)
        ];
      });
    },
    matches: (item, filters) => (!filters.platform
      || (item.licenses || [item.license]).some((license) => (license?.platform || 'unknown') === filters.platform))
      && (!filters.status || activationStatusKey(item) === filters.status)
      && (!filters.purpose || (item.purpose || 'new_account') === filters.purpose),
    searchPlaceholder: '搜索激活码、备注、账号或设备',
    searchText: (item) => {
      const licenses = item.licenses?.length ? item.licenses : (item.license ? [item.license] : []);
      return [
        item.maskedCode,
        item.note,
        item.purpose,
        item.account?.suffix,
        item.account?.id,
        ...licenses.flatMap((license) => [
          license.installationSuffix,
          license.platform,
          license.architecture,
          license.appVersion
        ])
      ];
    }
  });

  function renderActivations(payload) {
    const summary = payload.summary || {};
    const androidSummary = summary.platforms?.android || {};
    setText('overviewActiveLicenses', summary.active || 0);
    setText('overviewUnusedCodes', summary.unused || 0);
    const todoCodes = byId('overviewTodoCodes');
    if (todoCodes) {
      todoCodes.textContent = summary.unused > 0
        ? `还有 ${summary.unused} 个未使用激活码`
        : '当前没有未使用激活码';
    }
    setText('overviewAndroidDevices', androidSummary.active || 0);
    setText('androidActiveDevices', androidSummary.active || 0);
    setText('activationTotal', summary.total || 0);
    setText('activationAccounts', summary.accounts || 0);
    setText('activationUnused', summary.unused || 0);
    setText('activationActive', summary.active || 0);
    setText('activationRevoked', summary.revoked || 0);
    listView.setItems(payload.codes);
    renderAndroidDevices(payload.codes || []);
  }

  async function loadActivations() {
    await loadJson('/api/admin/activation-codes', renderActivations, byId('refreshActivationButton'));
  }

  bindClick('manageAndroidDevicesButton', () => {
    const platformFilter = document.querySelector(
      '[data-list-controls="activations"] [data-list-filter="platform"]'
    );
    if (platformFilter) {
      platformFilter.value = 'android';
      platformFilter.dispatchEvent(new Event('change'));
    }
    navigateTo('activations');
  });

  bindSubmit('generateCodeForm', async () => {
    await withBusy(byId('generateCodeButton'), async () => {
      const generated = await api('/api/admin/activation-codes', {
        method: 'POST',
        body: {
          count: Number(byId('activationCount').value),
          expiresInDays: Number(byId('activationExpiry').value),
          note: byId('activationNote').value.trim()
        }
      });
      byId('generatedCodesText').value = generated.codes.join('\n');
      byId('generatedCodesDialog').showModal();
      byId('activationNote').value = '';
      await loadActivations();
    });
  });

  bindClick('copyGeneratedCodesButton', () => copyText(
    byId('generatedCodesText').value,
    byId('generatedCodesText'),
    '激活码已复制',
    '激活码已选中'
  ));
  bindClick('refreshActivationButton', loadActivations);

  return { load: loadActivations };
});
