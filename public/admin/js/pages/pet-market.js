registerAdminPage(function createPetMarketPage({ ui, api, showToast }) {
  const { byId, cell, stackedCell, actionButton, actionsCell, fillTable, formatBytes, submitUpload } = ui;
  const root = byId('petMarketRoot');
  if (!root) return { id: 'pet-market', load: async () => {} };
  // This is a static shell. Product and filename values are always set as text.
  root.innerHTML = `
    <div class="summary-strip" aria-label="桌宠小铺规则">
      <span class="summary-item" data-tone="info">仅正式激活账号可领取、购买、下载和使用</span>
      <span class="summary-item" data-tone="success" id="petMarketDefaultSummary">尚未设置默认桌宠</span>
      <span class="summary-item" id="petMarketPaymentSummary">正在读取收款状态</span>
    </div>
    <section class="tool-panel">
      <div class="panel-heading inline-heading">
        <div><p class="eyebrow">桌宠小铺</p><h2>角色包与收费设置</h2></div>
        <div class="header-actions">
          <button id="refreshPetMarketButton" class="button button-secondary" type="button">刷新</button>
          <button id="petMarketPaymentSettingsButton" class="button button-secondary" type="button">收款设置</button>
          <a href="#pet-market-orders" class="button button-secondary">订单列表</a>
          <a href="#resource-packs" class="button button-secondary">管理小剧场 / 互动词库</a>
          <button id="createPetMarketButton" class="button button-primary" type="button">新增桌宠</button>
        </div>
      </div>
      <p class="field-hint">新建桌宠 → 选择角色文件夹或 GIF → 校验并上架。免费桌宠同样需要激活；调价不会改变已有订单和权益。</p>
      <p class="field-hint">小剧场和互动词库在“资源包”页面统一管理，供用户免费下载，安装后由用户在对应设置中启用。</p>
      <div class="pet-market-filters">
        <label><span>搜索桌宠</span><input id="petMarketSearch" type="search" placeholder="名称、标签或商品标识"></label>
        <label><span>上架状态</span><select id="petMarketStatusFilter"><option value="">全部状态</option><option value="published">已上架</option><option value="draft">草稿</option><option value="unlisted">已下架</option></select></label>
        <label><span>收费方式</span><select id="petMarketChargingFilter"><option value="">全部价格</option><option value="free">免费</option><option value="paid">收费</option></select></label>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>桌宠</th><th>收费</th><th>状态 / 默认</th><th>资源版本</th><th>公开预览</th><th class="actions-column">操作</th></tr></thead>
        <tbody id="petMarketRows"></tbody>
      </table><p id="emptyPetMarket" class="empty-state" hidden>还没有桌宠。先新增草稿，再上传资源包并上架。</p></div>
    </section>
    <form id="petMarketPaymentForm" class="drawer-form-stack" hidden>
      <p id="petMarketPaymentListenerStatus" class="field-hint" role="status"></p>
      <button id="petMarketRefreshPaymentStatus" type="button" class="button button-secondary">刷新监听状态</button>
      <label><span><input id="petMarketPaymentEnabled" type="checkbox"> 开启桌宠小铺收款</span></label>
      <label><span>收款方式</span><select id="petMarketPaymentMethod"><option value="personal_transfer">好友转账</option><option value="collection_qr">收款码</option></select></label>
      <label><span>收款人昵称</span><input id="petMarketRecipientName" maxlength="60" placeholder="付款时核对的微信昵称"></label>
      <label><span>收款微信号</span><input id="petMarketRecipientAccount" maxlength="32" placeholder="好友转账填写微信号" autocomplete="off"></label>
      <label><span>收款二维码（PNG / JPEG，不超过 256 KB）</span><input id="petMarketPaymentQrFile" type="file" accept="image/png,image/jpeg"></label>
      <img id="petMarketPaymentQrPreview" alt="收款二维码预览" width="192" height="192" hidden>
      <button id="petMarketPaymentQrClear" type="button" class="button button-secondary">清除收款二维码</button>
      <label><span>付款说明</span><textarea id="petMarketPaymentInstructions" maxlength="1000" rows="4" placeholder="例如：请先核对昵称和金额，转账说明只填写订单短码。"></textarea></label>
      <p class="field-hint">好友转账需要昵称和微信号；收款码需要昵称和二维码。对应收款监听就绪后才开放新订单。已生成订单保留原收款目标。</p>
      <p id="petMarketPaymentError" class="form-error" role="alert"></p>
    </form>
    <form id="petMarketForm" class="drawer-form-stack" hidden>
      <label><span>商品标识（创建后不可修改）</span><input id="petMarketId" pattern="[a-z0-9][a-z0-9-]{0,63}" maxlength="64" placeholder="例如 starter-cat" required></label>
      <label><span>桌宠名称</span><input id="petMarketTitle" maxlength="80" required></label>
      <label><span>简介</span><textarea id="petMarketDescription" rows="3" maxlength="600"></textarea></label>
      <label><span>标签（最多 4 个，每个不超过 12 个字）</span><input id="petMarketTags" maxlength="100" placeholder="例如：治愈、萌宠、打工搭子"><small>使用逗号、顿号或换行分隔。</small></label>
      <label><span><input id="petMarketIsFeatured" type="checkbox"> 精选推荐</span></label>
      <label><span>是否收费</span><select id="petMarketChargingMode"><option value="free">免费 · 激活后领取</option><option value="paid">收费 · 激活后购买</option></select></label>
      <label><span>收费价格</span><select id="petMarketPrice"><option value="280">普通款 ¥2.80</option><option value="380">¥3.80</option><option value="580">复杂 / 热门款 ¥5.80</option></select></label>
      <label><span>上架状态</span><select id="petMarketStatus"><option value="draft">草稿</option><option value="published">上架</option><option value="unlisted">下架</option></select></label>
      <label><span><input id="petMarketIsDefault" type="checkbox"> 设为默认免费桌宠（替换当前默认款）</span></label>
      <label><span>排序（数字越小越靠前）</span><input id="petMarketSortOrder" type="number" step="1" min="0" max="99999" value="0" required></label>
      <label><span>每包开放预览的内容</span><select id="petMarketPreviewMode"><option value="first5">前五个素材</option><option value="selected">后台手选（最多五个）</option><option value="none">关闭预览</option></select></label>
      <label id="petMarketPreviewPathsLabel"><span>手选素材路径（每行一个，与包内清单一致）</span><textarea id="petMarketPreviewPaths" rows="4" placeholder="animations/idle.gif"></textarea></label>
      <p id="petMarketAssetsHint" class="field-hint"></p>
      <p class="field-hint">完整包不放入公开资源下载。未激活用户只能看到这里允许的预览；没有已上传资源时不能上架。</p>
      <p id="petMarketFormError" class="form-error" role="alert"></p>
    </form>
    <form id="petMarketVersionForm" class="drawer-form-stack" hidden>
      <p id="petMarketUploadTitle" class="field-hint"></p>
      <label><span>资源版本</span><input id="petMarketVersion" maxlength="40" placeholder="1.0.0" required></label>
      <label><span>资源来源</span><select id="petMarketUploadSource"><option value="files">多选 GIF 图片</option><option value="folder">选择角色文件夹</option><option value="zip">已有桌宠 ZIP 包</option></select></label>
      <label id="petMarketFilesLabel"><span>GIF 图片</span><input id="petMarketFiles" type="file" accept=".gif,image/gif" multiple required></label>
      <label id="petMarketFolderLabel" hidden><span>角色文件夹</span><input id="petMarketFolder" type="file" accept=".gif,image/gif" webkitdirectory multiple></label>
      <label id="petMarketArchiveLabel" hidden><span>桌宠 ZIP</span><input id="petMarketArchive" type="file" accept=".zip,application/zip"></label>
      <p id="petMarketSelectionSummary" class="field-hint">请选择角色素材。</p>
      <p class="field-hint">直接选择 1–80 个 GIF，每个不超过 8 MB、宽高不超过 2048；服务端会生成清单并校验资源。已有 ZIP 需含 pet-market.json。新版本不能覆盖已购版本。</p>
      <label><span><input id="petMarketPublishAfterUpload" type="checkbox" checked> 资源校验通过后立即上架</span></label>
      <div id="petMarketProgress" class="progress-wrap" hidden><progress id="petMarketProgressBar" max="100" value="0"></progress><span id="petMarketProgressText">0%</span></div>
    </form>`;

  let editingProduct = null;
  let uploadProductId = null;
  let loading = false;
  let products = [];
  let paymentQrDataUrl = '';
  const form = byId('petMarketForm');
  const statusLabels = { draft: '草稿', published: '已上架', unlisted: '已下架' };
  const previewLabels = { first5: '前五个', selected: '手选素材', none: '不开放' };

  function updateFields() {
    const paid = byId('petMarketChargingMode').value === 'paid';
    const activeVersion = editingProduct?.activeVersion || '';
    const status = byId('petMarketStatus').value;
    const previewMode = byId('petMarketPreviewMode').value;
    const activeFiles = editingProduct?.versions?.find(version => version.version === activeVersion)?.files || [];
    const activePaths = new Set(activeFiles.map(file => typeof file === 'string' ? file : file.path));
    const previewPaths = byId('petMarketPreviewPaths').value
      .split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    byId('petMarketPrice').disabled = !paid;
    byId('petMarketPreviewPathsLabel').hidden = previewMode !== 'selected';
    byId('petMarketStatus').setCustomValidity(
      status === 'published' && !activeVersion ? '请先上传有效资源版本，再上架桌宠。' : ''
    );
    byId('petMarketPreviewMode').setCustomValidity(
      previewMode === 'selected' && (!activeVersion || previewPaths.some(path => !activePaths.has(path)))
        ? '手选预览必须来自当前活动资源版本。' : ''
    );
    byId('petMarketIsDefault').setCustomValidity(
      byId('petMarketIsDefault').checked && (paid || status !== 'published' || !activeVersion)
        ? '默认桌宠必须免费、已经上架且具有活动资源版本。' : ''
    );
  }

  function openEditor(product = null) {
    editingProduct = product;
    form.reset();
    byId('petMarketId').value = product?.id || '';
    byId('petMarketId').readOnly = Boolean(product);
    byId('petMarketTitle').value = product?.title || '';
    byId('petMarketDescription').value = product?.description || '';
    byId('petMarketTags').value = (product?.tags || []).join('、');
    byId('petMarketIsFeatured').checked = Boolean(product?.isFeatured);
    byId('petMarketChargingMode').value = product?.chargingMode || 'free';
    byId('petMarketPrice').value = String([280, 380, 580].includes(product?.priceFen) ? product.priceFen : 280);
    byId('petMarketStatus').value = product?.status || 'draft';
    byId('petMarketIsDefault').checked = Boolean(product?.isDefault);
    byId('petMarketSortOrder').value = String(product?.sortOrder || 0);
    byId('petMarketPreviewMode').value = product?.previewMode || 'first5';
    byId('petMarketPreviewPaths').value = (product?.previewPaths || []).join('\n');
    const files = product?.versions?.find(version => version.version === product.activeVersion)?.files || [];
    byId('petMarketAssetsHint').textContent = files.length
      ? `当前素材：${files.map(file => typeof file === 'string' ? file : file.path).join('、')}` : '尚无已上传素材。';
    byId('petMarketFormError').textContent = '';
    updateFields();
    globalThis.AdminFormKit.openFormDrawer({
      form, title: product ? `编辑 ${product.title}` : '新增桌宠', eyebrow: '桌宠小铺',
      submitLabel: '保存桌宠设置', focusSelector: product ? '#petMarketTitle' : '#petMarketId'
    });
  }

  function openUpload(product) {
    uploadProductId = product.id;
    const uploadForm = byId('petMarketVersionForm');
    uploadForm.reset();
    byId('petMarketUploadSource').value = 'files';
    byId('petMarketPublishAfterUpload').checked = true;
    byId('petMarketVersion').value = product.activeVersion ? '' : '1.0.0';
    updateUploadSource();
    byId('petMarketUploadTitle').textContent = `${product.title} · ${product.id}`;
    globalThis.AdminFormKit.openFormDrawer({
      form: uploadForm, title: '上传桌宠资源版本', eyebrow: product.title,
      submitLabel: '上传并校验资源', focusSelector: '#petMarketVersion'
    });
  }

  async function load() {
    if (loading) return;
    loading = true;
    byId('refreshPetMarketButton').disabled = true;
    try {
      const [payload, paymentPayload] = await Promise.all([
        api('/api/admin/pet-market/products'), api('/api/admin/pet-market/payment-settings')
      ]);
      products = payload.products || [];
      const defaultProduct = products.find(product => product.isDefault);
      byId('petMarketDefaultSummary').textContent = defaultProduct ? `默认免费款：${defaultProduct.title}` : '尚未设置默认桌宠';
      renderProducts();
      renderPaymentStatus(paymentPayload.payment);
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      loading = false;
      byId('refreshPetMarketButton').disabled = false;
    }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    updateFields();
    if (!form.reportValidity()) return;
    const button = document.querySelector('#editorDrawer .drawer-footer-actions .button-primary');
    if (button) button.disabled = true;
    byId('petMarketFormError').textContent = '';
    const body = {
      title: byId('petMarketTitle').value.trim(), description: byId('petMarketDescription').value.trim(),
      tags: [...new Set(byId('petMarketTags').value.split(/[,，、\n]/).map(tag => tag.trim()).filter(Boolean))],
      isFeatured: byId('petMarketIsFeatured').checked,
      chargingMode: byId('petMarketChargingMode').value,
      priceFen: byId('petMarketChargingMode').value === 'paid' ? Number(byId('petMarketPrice').value) : 0,
      status: byId('petMarketStatus').value, isDefault: byId('petMarketIsDefault').checked,
      sortOrder: Number(byId('petMarketSortOrder').value), previewMode: byId('petMarketPreviewMode').value,
      previewPaths: byId('petMarketPreviewMode').value === 'selected'
        ? byId('petMarketPreviewPaths').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean) : []
    };
    try {
      const url = '/api/admin/pet-market/products' + (editingProduct ? `/${encodeURIComponent(editingProduct.id)}` : '');
      if (!editingProduct) body.id = byId('petMarketId').value.trim();
      const saved = await api(url, { method: editingProduct ? 'PATCH' : 'POST', body });
      const isNew = !editingProduct;
      globalThis.AdminFormKit.closeDrawer();
      showToast('桌宠设置已保存');
      await load();
      if (isNew && saved.product) openUpload(saved.product);
    } catch (error) {
      byId('petMarketFormError').textContent = error.message;
    } finally {
      if (button) button.disabled = false;
    }
  });
  byId('petMarketVersionForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!uploadProductId) return;
    const currentUploadProductId = uploadProductId;
    const uploadForm = byId('petMarketVersionForm');
    if (!uploadForm.reportValidity()) return;
    const source = byId('petMarketUploadSource').value;
    const publishAfterUpload = byId('petMarketPublishAfterUpload').checked;
    let fileInput = byId('petMarketArchive');
    let uploadBody = { version: byId('petMarketVersion').value.trim() };
    if (source !== 'zip') {
      const selected = selectedGifFiles(source);
      if (selected.length < 1 || selected.length > 80 || selected.some(file => !/\.gif$/i.test(file.name)
          || file.size <= 0 || file.size > 8 * 1024 * 1024)
          || selected.reduce((sum, file) => sum + file.size, 0) > 64 * 1024 * 1024) {
        showToast('请选择 1–80 个有效 GIF，每个不超过 8 MB，总量不超过 64 MB。', 'error');
        return;
      }
      uploadBody = { ...uploadBody, sourceType: 'gif-files', files: selected.map(file => ({
        path: file.webkitRelativePath || file.name, sizeBytes: file.size
      })) };
      const combined = new File(selected, `${currentUploadProductId}-${uploadBody.version}.zip`, { type: 'application/octet-stream' });
      fileInput = { files: [combined] };
    }
    await submitUpload({
      form: uploadForm, fileInput,
      button: document.querySelector('#editorDrawer .drawer-footer-actions .button-primary'),
      progress: byId('petMarketProgress'), progressBar: byId('petMarketProgressBar'), progressText: byId('petMarketProgressText'),
      createPath: `/api/admin/pet-market/products/${encodeURIComponent(currentUploadProductId)}/versions`,
      body: () => uploadBody,
      afterUpload: async () => {
        if (!publishAfterUpload) return;
        try {
          await api(`/api/admin/pet-market/products/${encodeURIComponent(currentUploadProductId)}`, {
            method: 'PATCH', body: { status: 'published' }
          });
        } catch (error) {
          showToast(`资源已保存，上架失败：${error.message}。请在列表中重新上架。`, 'error');
        }
      },
      afterReset: () => globalThis.AdminFormKit.closeDrawer(), reload: load, successText: '资源版本已上传并验证'
    });
  });
  for (const id of ['petMarketChargingMode', 'petMarketStatus', 'petMarketIsDefault', 'petMarketPreviewMode']) byId(id).addEventListener('change', updateFields);
  byId('petMarketPreviewPaths').addEventListener('input', updateFields);
  byId('refreshPetMarketButton').addEventListener('click', load);
  byId('createPetMarketButton').addEventListener('click', () => openEditor());
  byId('petMarketPaymentSettingsButton').addEventListener('click', openPaymentSettings);
  byId('petMarketRefreshPaymentStatus').addEventListener('click', async () => {
    try { renderPaymentStatus((await api('/api/admin/pet-market/payment-settings')).payment); }
    catch (error) { showToast(error.message, 'error'); }
  });
  byId('petMarketPaymentQrClear').addEventListener('click', () => { paymentQrDataUrl = ''; renderPaymentQr(); });
  byId('petMarketPaymentQrFile').addEventListener('change', async () => {
    const file = byId('petMarketPaymentQrFile').files[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 256 * 1024) {
      byId('petMarketPaymentError').textContent = '请选择不超过 256 KB 的 PNG 或 JPEG 收款码。';
      return;
    }
    try {
      paymentQrDataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('二维码读取失败，请重试。'));
        reader.readAsDataURL(file);
      });
      byId('petMarketPaymentError').textContent = '';
      renderPaymentQr();
    } catch (error) { byId('petMarketPaymentError').textContent = error.message; }
  });
  byId('petMarketPaymentForm').addEventListener('submit', async event => {
    event.preventDefault();
    const button = document.querySelector('#editorDrawer .drawer-footer-actions .button-primary');
    if (button) button.disabled = true;
    byId('petMarketPaymentError').textContent = '';
    try {
      const result = await api('/api/admin/pet-market/payment-settings', { method: 'PUT', body: {
        enabled: byId('petMarketPaymentEnabled').checked,
        method: byId('petMarketPaymentMethod').value,
        recipientName: byId('petMarketRecipientName').value.trim(),
        recipientAccount: byId('petMarketRecipientAccount').value.trim(),
        qrCodeDataUrl: paymentQrDataUrl,
        instructions: byId('petMarketPaymentInstructions').value.trim()
      } });
      renderPaymentStatus(result.payment);
      showToast(result.payment.available ? '收款设置已保存，监听在线' : '收款设置已保存；' + result.payment.unavailableReason);
      globalThis.AdminFormKit.closeDrawer();
    } catch (error) { byId('petMarketPaymentError').textContent = error.message; }
    finally { if (button) button.disabled = false; }
  });
  for (const id of ['petMarketSearch', 'petMarketStatusFilter', 'petMarketChargingFilter']) {
    byId(id).addEventListener(id === 'petMarketSearch' ? 'input' : 'change', renderProducts);
  }
  byId('petMarketUploadSource').addEventListener('change', updateUploadSource);
  for (const id of ['petMarketFiles', 'petMarketFolder', 'petMarketArchive']) byId(id).addEventListener('change', updateSelectionSummary);
  function renderProducts() {
    const query = byId('petMarketSearch').value.trim().toLowerCase();
    const status = byId('petMarketStatusFilter').value;
    const charging = byId('petMarketChargingFilter').value;
    const visible = products.filter(product => (!status || product.status === status)
      && (!charging || product.chargingMode === charging)
      && (!query || [product.title, product.id, ...(product.tags || [])].join(' ').toLowerCase().includes(query)));
    fillTable(byId('petMarketRows'), visible, product => {
      const version = product.versions?.find(item => item.version === product.activeVersion) || {};
      const details = stackedCell('pet-market-product-text', product.title,
        (product.tags || []).join(' · ') || '未设置标签', product.id);
      const cover = document.createElement('div');
      cover.className = 'pet-market-product';
      const preview = product.previewFiles?.[0];
      if (preview?.downloadPath?.startsWith('/api/pet-market/products/')) {
        const img = document.createElement('img');
        img.src = preview.downloadPath;
        img.alt = `${product.title}预览`;
        img.className = 'pet-market-cover';
        img.loading = 'lazy';
        cover.append(img);
      } else {
        const placeholder = document.createElement('span');
        placeholder.className = 'pet-market-cover pet-market-cover-empty';
        placeholder.textContent = '暂无公开预览';
        cover.append(placeholder);
      }
      const content = document.createElement('div');
      for (const part of Array.from(details.childNodes)) content.append(part);
      cover.append(content);
      const productCell = cell();
      productCell.append(cover);
      const buttons = [actionButton('设置', 'button-secondary', () => openEditor(product)),
        actionButton('上传资源', 'button-secondary', () => openUpload(product))];
      if (product.activeVersion && product.status !== 'published') buttons.push(actionButton('上架', 'button-primary', async () => {
        try {
          await api(`/api/admin/pet-market/products/${encodeURIComponent(product.id)}`, { method: 'PATCH', body: { status: 'published' } });
          showToast('桌宠已上架');
          await load();
        } catch (error) { showToast(error.message, 'error'); }
      }));
      return [productCell,
        cell('', product.chargingMode === 'paid' ? `¥${(product.priceFen / 100).toFixed(2)}` : '免费 · 需激活'),
        stackedCell('pet-market-state', statusLabels[product.status] || product.status,
          product.isDefault ? { text: '默认桌宠', className: 'pet-market-badge' } : null,
          product.isFeatured ? { text: '精选推荐', className: 'pet-market-badge pet-market-badge-featured' } : null),
        stackedCell('pet-market-version', version.version || '未上传', `${version.assetCount || 0} 个素材`, formatBytes(version.sizeBytes || 0)),
        cell('', previewLabels[product.previewMode] || '不开放'), actionsCell(...buttons)];
    }, byId('emptyPetMarket'));
    byId('emptyPetMarket').textContent = products.length ? '没有符合筛选条件的桌宠。' : '还没有桌宠。先新增草稿，再选择 GIF 素材上架。';
  }
  function updateUploadSource() {
    const source = byId('petMarketUploadSource').value;
    for (const [value, inputId, labelId] of [
      ['files', 'petMarketFiles', 'petMarketFilesLabel'], ['folder', 'petMarketFolder', 'petMarketFolderLabel'],
      ['zip', 'petMarketArchive', 'petMarketArchiveLabel']
    ]) {
      byId(labelId).hidden = source !== value;
      byId(inputId).required = source === value;
    }
    updateSelectionSummary();
  }
  function updateSelectionSummary() {
    const source = byId('petMarketUploadSource').value;
    const files = source === 'zip' ? Array.from(byId('petMarketArchive').files) : selectedGifFiles(source);
    const ignored = source === 'folder' ? byId('petMarketFolder').files.length - files.length : 0;
    byId('petMarketSelectionSummary').textContent = files.length
      ? `已选择 ${files.length} 个文件，共 ${formatBytes(files.reduce((total, file) => total + file.size, 0))}${ignored ? `；已忽略 ${ignored} 个非 GIF 文件` : ''}`
      : '请选择角色素材。';
  }
  function selectedGifFiles(source) {
    const files = Array.from(byId(source === 'folder' ? 'petMarketFolder' : 'petMarketFiles').files);
    return source === 'folder' ? files.filter(file => /\.gif$/i.test(file.name)) : files;
  }
  function renderPaymentStatus(payment) {
    if (!payment) return;
    const state = payment.listenerOnline ? '收款监听在线' : '收款监听未连接';
    byId('petMarketPaymentSummary').textContent = payment.available ? `${state} · 可下单` : payment.unavailableReason;
    byId('petMarketPaymentListenerStatus').textContent = state + (payment.available ? '，可接收新订单。' : `；${payment.unavailableReason}`);
  }
  function renderPaymentQr() {
    const image = byId('petMarketPaymentQrPreview');
    image.hidden = !paymentQrDataUrl;
    if (paymentQrDataUrl) image.src = paymentQrDataUrl;
    else image.removeAttribute('src');
  }
  async function openPaymentSettings() {
    try {
      const { payment } = await api('/api/admin/pet-market/payment-settings');
      byId('petMarketPaymentEnabled').checked = payment.enabled;
      byId('petMarketPaymentMethod').value = payment.method;
      byId('petMarketRecipientName').value = payment.recipientName;
      byId('petMarketRecipientAccount').value = payment.recipientAccount;
      byId('petMarketPaymentInstructions').value = payment.instructions;
      byId('petMarketPaymentError').textContent = '';
      byId('petMarketPaymentQrFile').value = '';
      paymentQrDataUrl = payment.qrCodeDataUrl;
      renderPaymentQr();
      renderPaymentStatus(payment);
      globalThis.AdminFormKit.openFormDrawer({ form: byId('petMarketPaymentForm'), title: '收款设置',
        eyebrow: '桌宠小铺', submitLabel: '保存收款设置', focusSelector: '#petMarketRecipientName' });
    } catch (error) { showToast(error.message, 'error'); }
  }
  return { id: 'pet-market', load };
});
