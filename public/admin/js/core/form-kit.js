(function (global) {
  'use strict';

  let restoreDrawerForm = null;

  function releaseDrawerForm() {
    const restore = restoreDrawerForm;
    restoreDrawerForm = null;
    restore?.();
  }

  function openDrawer({ title, eyebrow = '编辑', body, footer }) {
    const drawer = document.querySelector('#editorDrawer');
    const backdrop = document.querySelector('#drawerBackdrop');
    const drawerBody = document.querySelector('#drawerBody');
    const drawerFooter = document.querySelector('#drawerFooter');
    if (!drawer || !backdrop || !drawerBody || !drawerFooter) return;
    releaseDrawerForm();
    document.querySelector('#drawerTitle').textContent = title;
    document.querySelector('#drawerEyebrow').textContent = eyebrow;
    drawerBody.replaceChildren(body || document.createElement('div'));
    drawerFooter.replaceChildren(...(Array.isArray(footer) ? footer : footer ? [footer] : []));
    drawer.hidden = false;
    backdrop.hidden = false;
  }

  function closeDrawer() {
    releaseDrawerForm();
    const drawer = document.querySelector('#editorDrawer');
    const backdrop = document.querySelector('#drawerBackdrop');
    if (drawer) drawer.hidden = true;
    if (backdrop) backdrop.hidden = true;
  }

  function openFormDrawer({
    form,
    title,
    eyebrow = '新建',
    submitLabel = '保存',
    cancelLabel = '取消',
    onCancel,
    focusSelector
  }) {
    if (!form) return;
    releaseDrawerForm();
    const originalParent = form.parentNode;
    const originalNextSibling = form.nextSibling;
    form.hidden = false;

    const footer = document.createElement('div');
    footer.className = 'drawer-footer-actions';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'button button-secondary';
    cancel.textContent = cancelLabel;
    cancel.addEventListener('click', () => {
      onCancel?.();
      form.hidden = true;
      closeDrawer();
    });

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'button button-primary';
    save.textContent = submitLabel;
    save.addEventListener('click', () => {
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });

    footer.append(cancel, save);
    openDrawer({ title, eyebrow, body: form, footer });
    // Pages find reusable form fields by ID after saving and while refreshing.
    // Return the actual form (including its listeners) before replacing drawer content.
    restoreDrawerForm = () => {
      form.hidden = true;
      if (originalParent) {
        if (originalNextSibling?.parentNode === originalParent) {
          originalParent.insertBefore(form, originalNextSibling);
        } else {
          originalParent.append(form);
        }
      } else {
        form.remove();
      }
    };

    const focusNode = focusSelector
      ? form.querySelector(focusSelector)
      : form.querySelector('input:not([type="hidden"]):not([type="file"]), select, textarea');
    focusNode?.focus?.({ preventScroll: true });

    return { cancel, save };
  }

  document.querySelector('#drawerCloseButton')?.addEventListener('click', closeDrawer);
  document.querySelector('#drawerBackdrop')?.addEventListener('click', closeDrawer);

  global.AdminFormKit = { openDrawer, closeDrawer, openFormDrawer };
})(window);
