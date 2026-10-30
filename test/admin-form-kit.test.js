const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'js', 'core', 'form-kit.js'), 'utf8');

function fixture() {
  function node(tag = 'div', id = '') {
    const listeners = new Map();
    return {
      tagName: tag.toUpperCase(), id, parentNode: null, childNodes: [], hidden: false,
      get nextSibling() {
        return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1] || null;
      },
      append(...children) {
        for (const child of children) {
          child.remove();
          child.parentNode = this;
          this.childNodes.push(child);
        }
      },
      insertBefore(child, reference) {
        child.remove();
        const index = this.childNodes.indexOf(reference);
        assert.notEqual(index, -1);
        child.parentNode = this;
        this.childNodes.splice(index, 0, child);
      },
      replaceChildren(...children) {
        for (const child of [...this.childNodes]) child.remove();
        this.append(...children);
      },
      remove() {
        if (!this.parentNode) return;
        this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1);
        this.parentNode = null;
      },
      querySelector(selector) {
        for (const child of this.childNodes) {
          if (selector === `#${child.id}`) return child;
          const descendant = child.querySelector(selector);
          if (descendant) return descendant;
        }
        return null;
      },
      addEventListener(event, listener) { listeners.set(event, [...(listeners.get(event) || []), listener]); },
      dispatch(event) { for (const listener of listeners.get(event) || []) listener({ preventDefault() {} }); },
      requestSubmit() { this.dispatch('submit'); },
      focus() {}
    };
  }
  const document = node();
  document.createElement = tag => node(tag);
  const page = node('section', 'petMarketRoot');
  const productForm = node('form', 'petMarketForm');
  const productTitle = node('input', 'petMarketTitle');
  productTitle.value = '已编辑的桌宠名称';
  const paymentForm = node('form', 'petMarketPaymentForm');
  const paymentStatus = node('p', 'petMarketPaymentListenerStatus');
  productForm.append(productTitle);
  paymentForm.append(paymentStatus);
  productForm.hidden = paymentForm.hidden = true;
  page.append(productForm, paymentForm);
  const drawer = node('aside', 'editorDrawer');
  const body = node('div', 'drawerBody');
  const footer = node('div', 'drawerFooter');
  const close = node('button', 'drawerCloseButton');
  const backdrop = node('div', 'drawerBackdrop');
  drawer.append(node('h2', 'drawerTitle'), node('p', 'drawerEyebrow'), close, body, footer);
  drawer.hidden = backdrop.hidden = true;
  document.append(page, drawer, backdrop);
  const window = {};
  vm.runInNewContext(script, { document, window });
  return { kit: window.AdminFormKit, document, node, page, productForm, productTitle,
    paymentForm, paymentStatus, drawer, body, footer, close, backdrop };
}

test('switching admin forms preserves both reusable forms and their fields in the document', () => {
  const f = fixture();
  f.kit.openFormDrawer({ form: f.paymentForm, title: '收款设置' });
  f.kit.openFormDrawer({ form: f.productForm, title: '桌宠设置' });
  assert.equal(f.document.querySelector('#petMarketPaymentListenerStatus'), f.paymentStatus,
    'the post-save refresh must still find the payment status field');
  assert.equal(f.paymentForm.parentNode, f.page);
  assert.equal(f.paymentForm.hidden, true);
  assert.equal(f.productForm.parentNode, f.body);
  f.kit.openFormDrawer({ form: f.paymentForm, title: '收款设置' });
  assert.equal(f.document.querySelector('#petMarketTitle'), f.productTitle);
  assert.equal(f.productTitle.value, '已编辑的桌宠名称');
  f.kit.closeDrawer();
  assert.deepEqual(f.page.childNodes, [f.productForm, f.paymentForm]);
});

test('all drawer close paths return forms and repeated opening retains one submit handler', () => {
  for (const closeAction of ['close', 'backdrop', 'cancel', 'save']) {
    const f = fixture();
    let submissions = 0;
    f.productForm.addEventListener('submit', () => { submissions += 1; f.kit.closeDrawer(); });
    const buttons = f.kit.openFormDrawer({ form: f.productForm, title: '桌宠设置' });
    if (closeAction === 'cancel' || closeAction === 'save') buttons[closeAction].dispatch('click');
    else f[closeAction].dispatch('click');
    assert.equal(f.productForm.parentNode, f.page, closeAction);
    assert.equal(f.productForm.hidden, true, closeAction);
    assert.equal(f.drawer.hidden, true, closeAction);
    const reopened = f.kit.openFormDrawer({ form: f.productForm, title: '桌宠设置' });
    reopened.save.dispatch('click');
    assert.equal(submissions, closeAction === 'save' ? 2 : 1);
    assert.equal(f.productTitle.value, '已编辑的桌宠名称');
  }
});

test('replacing a form with a non-form drawer restores the form for later editing', () => {
  const f = fixture();
  f.kit.openFormDrawer({ form: f.productForm, title: '桌宠设置' });
  f.kit.openDrawer({ title: '其他详情', body: f.node() });
  assert.equal(f.document.querySelector('#petMarketTitle'), f.productTitle);
  assert.equal(f.productForm.parentNode, f.page);
  assert.equal(f.productForm.hidden, true);
});
