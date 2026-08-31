(function (global) {
  'use strict';

  const PAGE_SIZES = [10, 20, 50, 100];
  const DEFAULT_PAGE_SIZE = 20;

  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes)) return '-';
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(date);
  }

  function cell(className = '', text) {
    const node = document.createElement('td');
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function actionButton(label, className, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `button ${className}`;
    button.textContent = label;
    button.addEventListener('click', handler);
    return button;
  }

  function stackedCell(className, ...parts) {
    const node = cell(className);
    for (const part of parts) {
      if (part == null || part === false) continue;
      if (part instanceof Node) {
        node.append(part);
        continue;
      }
      if (typeof part === 'object') {
        const child = document.createElement(part.tag || 'span');
        if (part.className) child.className = part.className;
        child.textContent = part.text;
        node.append(child);
        continue;
      }
      const child = document.createElement(node.childNodes.length === 0 ? 'strong' : 'span');
      child.textContent = part;
      node.append(child);
    }
    return node;
  }

  function statusBadge(text, className = '') {
    const status = document.createElement('span');
    status.className = `status-badge${className ? ` ${className}` : ''}`.trim();
    status.textContent = text;
    return status;
  }

  function badgeCell(text, className) {
    const node = cell();
    node.append(statusBadge(text, className));
    return node;
  }

  function hashCell(value) {
    const node = cell('hash');
    const hash = String(value || '');
    node.title = hash;
    node.textContent = hash ? `${hash.slice(0, 12)}…${hash.slice(-8)}` : '-';
    return node;
  }

  function actionsCell(...buttons) {
    const node = cell();
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.append(...buttons.filter(Boolean));
    node.append(actions);
    return node;
  }

  function fillTable(tbody, items, buildRow, emptyElement) {
    const rows = [];
    for (const item of items) {
      const built = buildRow(item);
      if (!built) continue;
      if (built instanceof Node) {
        rows.push(built);
      } else {
        const row = document.createElement('tr');
        row.append(...built);
        rows.push(row);
      }
    }
    tbody.replaceChildren(...rows);
    if (emptyElement) emptyElement.hidden = items.length > 0;
  }

  function createListView(name, { emptyElement, renderPage, matches }) {
    const controls = document.querySelector(`[data-list-controls="${name}"]`);
    const pagination = document.querySelector(`[data-list-pagination="${name}"]`);
    if (!pagination) {
      throw new Error(`缺少分页容器：${name}`);
    }
    const filterElements = Array.from(controls?.querySelectorAll('[data-list-filter]') || []);
    const pageSize = document.createElement('select');
    pageSize.setAttribute('aria-label', '每页显示条数');
    for (const value of PAGE_SIZES) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = String(value);
      option.selected = value === DEFAULT_PAGE_SIZE;
      pageSize.append(option);
    }
    const pageSizeLabel = document.createElement('label');
    pageSizeLabel.className = 'page-size-control';
    const pageSizeText = document.createElement('span');
    pageSizeText.textContent = '每页';
    pageSizeLabel.append(pageSizeText, pageSize);

    const range = document.createElement('span');
    range.className = 'pagination-range';
    const pageLabel = document.createElement('span');
    pageLabel.className = 'pagination-page';
    const previous = document.createElement('button');
    previous.type = 'button';
    previous.className = 'button button-secondary pagination-button';
    previous.textContent = '←';
    previous.title = '上一页';
    previous.setAttribute('aria-label', '上一页');
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'button button-secondary pagination-button';
    next.textContent = '→';
    next.title = '下一页';
    next.setAttribute('aria-label', '下一页');
    const navigation = document.createElement('div');
    navigation.className = 'pagination-navigation';
    navigation.append(previous, pageLabel, next);
    pagination.replaceChildren(pageSizeLabel, range, navigation);

    let items = [];
    let currentPage = 1;

    function filterValues() {
      return Object.fromEntries(filterElements.map((element) => [element.dataset.listFilter, element.value]));
    }

    function render() {
      const filters = filterValues();
      const filtered = matches ? items.filter((item) => matches(item, filters)) : [...items];
      const size = Number(pageSize.value);
      const pageCount = Math.max(1, Math.ceil(filtered.length / size));
      currentPage = Math.min(currentPage, pageCount);
      const start = (currentPage - 1) * size;
      const visibleItems = filtered.slice(start, start + size);
      renderPage(visibleItems);
      emptyElement.hidden = filtered.length > 0;
      range.textContent = filtered.length
        ? `${start + 1}-${start + visibleItems.length} / ${filtered.length} 条`
        : '0 条';
      pageLabel.textContent = `${currentPage} / ${pageCount}`;
      previous.disabled = currentPage <= 1;
      next.disabled = currentPage >= pageCount;
    }

    for (const element of filterElements) {
      element.addEventListener('change', () => {
        currentPage = 1;
        render();
      });
    }
    pageSize.addEventListener('change', () => {
      currentPage = 1;
      render();
    });
    previous.addEventListener('click', () => {
      if (currentPage <= 1) return;
      currentPage -= 1;
      render();
    });
    next.addEventListener('click', () => {
      currentPage += 1;
      render();
    });

    return {
      setItems(nextItems) {
        items = Array.isArray(nextItems) ? nextItems : [];
        render();
      },
      refresh() {
        render();
      }
    };
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function setText(id, value) {
    const node = typeof id === 'string' ? byId(id) : id;
    if (node) node.textContent = value;
  }

  function formatRate(value) {
    const rate = Number(value);
    return Number.isFinite(rate) ? `${(rate * 100).toFixed(1)}%` : '-';
  }

  function formatDay(date, timeZone = 'Asia/Shanghai') {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date).reduce((result, part) => {
      if (part.type !== 'literal') result[part.type] = part.value;
      return result;
    }, {});
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function bindClick(id, handler) {
    const node = typeof id === 'string' ? byId(id) : id;
    if (node) node.addEventListener('click', handler);
    return node;
  }

  function bindSubmit(form, handler) {
    const node = typeof form === 'string' ? byId(form) : form;
    if (!node) return node;
    node.addEventListener('submit', (event) => {
      event.preventDefault();
      handler(event);
    });
    return node;
  }

  const pageFactories = [];
  function registerAdminPage(factory) {
    pageFactories.push(factory);
  }

  function createAdminPages(context) {
    return pageFactories.map((factory) => factory(context));
  }

  function createAdminUI({ api, showToast, showLogin, getCsrfToken }) {
    async function withBusy(button, work, onError) {
      if (button) button.disabled = true;
      try {
        return await work();
      } catch (error) {
        if (onError) onError(error);
        else showToast(error.message, 'error');
      } finally {
        if (button) button.disabled = false;
      }
    }

    async function loadJson(path, render, button) {
      return withBusy(button, async () => {
        render(await api(path));
      });
    }

    async function copyText(value, fallbackNode, successText, fallbackText) {
      try {
        await navigator.clipboard.writeText(value);
        showToast(successText);
      } catch {
        fallbackNode?.select?.();
        showToast(fallbackText);
      }
    }

    function uploadBinary(uploadUrl, file, progressBar, progressText) {
      return new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open('PUT', uploadUrl);
        request.responseType = 'json';
        request.setRequestHeader('Content-Type', 'application/octet-stream');
        request.setRequestHeader('X-CSRF-Token', getCsrfToken());
        request.upload.addEventListener('progress', (event) => {
          if (!event.lengthComputable) return;
          const progress = Math.min(100, Math.round(event.loaded / event.total * 100));
          progressBar.value = progress;
          progressText.textContent = `${progress}%`;
        });
        request.addEventListener('load', () => {
          if (request.status >= 200 && request.status < 300) return resolve(request.response);
          const error = new Error(request.response?.error || `上传失败 (${request.status})`);
          error.status = request.status;
          reject(error);
        });
        request.addEventListener('error', () => reject(new Error('上传连接中断')));
        request.addEventListener('abort', () => reject(new Error('上传已取消')));
        request.send(file);
      });
    }

    async function submitUpload({
      form,
      fileInput,
      button,
      progress,
      progressBar,
      progressText,
      createPath,
      body,
      afterReset,
      reload,
      successText
    }) {
      const file = fileInput.files[0];
      if (!file) return;
      progress.hidden = false;
      progressBar.value = 0;
      progressText.textContent = '0%';
      await withBusy(button, async () => {
        const task = await api(createPath, {
          method: 'POST',
          body: { ...body(file), fileName: file.name, fileSize: file.size }
        });
        await uploadBinary(task.uploadUrl, file, progressBar, progressText);
        progressBar.value = 100;
        progressText.textContent = '100%';
        form.reset();
        afterReset?.();
        showToast(successText);
        await reload();
      }, (error) => {
        if (error.status === 401) showLogin('登录已失效，请重新登录');
        showToast(error.message, 'error');
      });
      window.setTimeout(() => {
        progress.hidden = true;
      }, 800);
    }

    return {
      byId,
      setText,
      bindClick,
      bindSubmit,
      formatBytes,
      formatDate,
      formatRate,
      formatDay,
      cell,
      actionButton,
      stackedCell,
      statusBadge,
      badgeCell,
      hashCell,
      actionsCell,
      fillTable,
      createListView,
      withBusy,
      loadJson,
      copyText,
      submitUpload
    };
  }

  global.createAdminUI = createAdminUI;
  global.registerAdminPage = registerAdminPage;
  global.createAdminPages = createAdminPages;
})(window);
