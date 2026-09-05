const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require(process.env.JSDOM_PATH || 'jsdom');
const fs = require('node:fs');
const path = require('node:path');
const Content = require('../safe-content.js');

function setup(text, options = {}) {
  const dom = new JSDOM('<main id="answer"></main>');
  const container = dom.window.document.querySelector('#answer');
  Content.render(container, text, options);
  return { dom, container };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('render clears stale content and renders headings and plain text with DOM nodes', () => {
  const dom = new JSDOM('<main id="answer"><em>stale</em></main>');
  try {
    const container = dom.window.document.querySelector('#answer');
    Content.render(container, '# Título\n\nTexto seguro');
    assert.equal(container.querySelector('em'), null);
    assert.equal(container.querySelector('h1').textContent, 'Título');
    assert.equal(container.querySelector('p').textContent, 'Texto seguro');
  } finally {
    dom.window.close();
  }
});

test('render structures unordered and ordered lists', () => {
  const { dom, container } = setup('- uno\n- dos\n\n1. primero\n2) segundo');
  try {
    assert.deepEqual([...container.querySelectorAll('ul li')].map((node) => node.textContent), ['uno', 'dos']);
    assert.deepEqual([...container.querySelectorAll('ol li')].map((node) => node.textContent), ['primero', 'segundo']);
  } finally {
    dom.window.close();
  }
});

test('render preserves closed and unclosed fenced code as code', () => {
  const { dom, container } = setup('```js\nconst x = "<tag>";\n```\n\n```\nunclosed');
  try {
    const blocks = [...container.querySelectorAll('pre code')];
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].textContent, 'const x = "<tag>";');
    assert.equal(blocks[0].dataset.language, 'js');
    assert.equal(blocks[1].textContent, 'unclosed');
  } finally {
    dom.window.close();
  }
});

test('malicious HTML and javascript URLs stay inert and visible as text', () => {
  const attack = '<img src=x onerror="globalThis.pwned=1"><script>pwned=2</script> javascript:alert(1)';
  const { dom, container } = setup(attack);
  try {
    assert.equal(container.querySelector('img, script, a'), null);
    assert.equal(container.textContent.includes(attack), true);
    assert.equal(dom.window.pwned, undefined);
  } finally {
    dom.window.close();
  }
});

test('copy buttons write the complete original answer and exact code block', async () => {
  const original = '# Encabezado\n\nAntes\n```js\nconst answer = 42;\n```\nDespués';
  const copied = [];
  const notices = [];
  const clipboard = { writeText: async (value) => copied.push(value) };
  const { dom, container } = setup(original, { clipboard, notify: (message) => notices.push(message) });
  try {
    const answerButton = container.querySelector('.copy-answer');
    const codeButton = container.querySelector('.copy-code');
    assert.equal(answerButton.type, 'button');
    assert.equal(codeButton.type, 'button');
    answerButton.click();
    await flush();
    codeButton.click();
    await flush();
    assert.deepEqual(copied, [original, 'const answer = 42;']);
    assert.deepEqual(notices, ['Respuesta copiada.', 'Código copiado.']);
  } finally {
    dom.window.close();
  }
});

test('denied clipboard selects the complete original text and gives manual instructions', async () => {
  const original = '# Título\n\ntexto';
  const notices = [];
  const clipboard = { writeText: async () => { throw new Error('denied'); } };
  const { dom, container } = setup(original, { clipboard, notify: (message) => notices.push(message) });
  try {
    const button = container.querySelector('.copy-answer');
    button.click();
    await flush();
    const source = container.querySelector('.manual-copy-source');
    assert.equal(source.value, original);
    assert.equal(source.selectionStart, 0);
    assert.equal(source.selectionEnd, original.length);
    assert.equal(button.dataset.copyState, 'manual');
    assert.match(notices[0], /seleccionado/i);
    assert.notEqual(notices[0], 'Respuesta copiada.');
  } finally {
    dom.window.close();
  }
});

test('missing clipboard selects exact code and never claims success', async () => {
  const notices = [];
  const { dom, container } = setup('```\nline 1\nline 2\n```', { clipboard: null, notify: (message) => notices.push(message) });
  try {
    const button = container.querySelector('.copy-code');
    button.click();
    await flush();
    const source = container.querySelector('.safe-code-block .manual-copy-source');
    assert.equal(source.value, 'line 1\nline 2');
    assert.equal(source.selectionEnd, source.value.length);
    assert.equal(button.dataset.copyState, 'manual');
    assert.equal(container.textContent.includes('Código copiado.'), false);
    assert.equal(notices.includes('Código copiado.'), false);
  } finally {
    dom.window.close();
  }
});

test('code copy preserves original CRLF and whitespace inside a fence', async () => {
  const copied = [];
  const { dom, container } = setup('```txt\r\n  first  \r\n\r\nsecond\r\n```', {
    clipboard: { writeText: async (value) => copied.push(value) }
  });
  try {
    container.querySelector('.copy-code').click();
    await flush();
    assert.deepEqual(copied, ['  first  \r\n\r\nsecond']);
  } finally {
    dom.window.close();
  }
});

test('browser build exposes window.AgentHubContent without CommonJS globals', () => {
  const dom = new JSDOM('<main id="answer"></main>', { runScripts: 'outside-only' });
  try {
    const source = fs.readFileSync(path.join(__dirname, '..', 'safe-content.js'), 'utf8');
    dom.window.eval(source);
    assert.equal(typeof dom.window.AgentHubContent.render, 'function');
    dom.window.AgentHubContent.render(dom.window.document.querySelector('#answer'), 'Browser');
    assert.equal(dom.window.document.querySelector('p').textContent, 'Browser');
  } finally {
    dom.window.close();
  }
});
