(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentHubContent = api;
})(typeof globalThis === 'object' ? globalThis : self, function () {
  'use strict';

  function appendLines(document, element, lines) {
    lines.forEach(function (line, index) {
      if (index) element.appendChild(document.createElement('br'));
      element.appendChild(document.createTextNode(line));
    });
  }

  function lineText(line) {
    return line && line.endsWith('\r') ? line.slice(0, -1) : line;
  }

  function listItem(line) {
    line = lineText(line);
    var unordered = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (unordered) return { ordered: false, text: unordered[1] };
    var ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    return ordered ? { ordered: true, text: ordered[1] } : null;
  }

  function fenceOpen(line) {
    return /^\s*```([^`]*)$/.exec(lineText(line));
  }

  function copyButton(document, className, label, value, selectionTarget, clipboard, notify, successMessage) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.setAttribute('aria-label', label);
    var status = document.createElement('span');
    var manualSource = null;
    status.className = 'copy-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    button.addEventListener('click', async function () {
      try {
        if (!clipboard || typeof clipboard.writeText !== 'function') throw new Error('Clipboard unavailable');
        await clipboard.writeText(value);
        button.dataset.copyState = 'success';
        status.textContent = 'Copiado.';
        notify(successMessage);
      } catch (_) {
        var view = document.defaultView;
        var selection = view && typeof view.getSelection === 'function' ? view.getSelection() : null;
        if (selection && selectionTarget) {
          var range = document.createRange();
          range.selectNodeContents(selectionTarget);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        if (!manualSource) {
          manualSource = document.createElement('textarea');
          manualSource.className = 'manual-copy-source';
          manualSource.readOnly = true;
          manualSource.rows = 4;
          manualSource.setAttribute('aria-label', 'Texto para copiar manualmente');
          status.parentNode.appendChild(manualSource);
        }
        manualSource.value = value;
        manualSource.focus();
        manualSource.select();
        manualSource.setSelectionRange(0, value.length);
        var manualMessage = 'No se pudo copiar automáticamente. El texto está seleccionado; usa Copiar del menú o Ctrl/Cmd+C.';
        button.dataset.copyState = 'manual';
        status.textContent = manualMessage;
        notify(manualMessage);
      }
    });
    var fragment = document.createDocumentFragment();
    fragment.appendChild(button);
    fragment.appendChild(status);
    return fragment;
  }

  function render(container, text, options) {
    options = options || {};
    if (!container || !container.ownerDocument) throw new TypeError('Se necesita un contenedor DOM.');
    text = text == null ? '' : String(text);
    var document = container.ownerDocument;
    var view = document.defaultView;
    var clipboard = Object.prototype.hasOwnProperty.call(options, 'clipboard')
      ? options.clipboard
      : view && view.navigator && view.navigator.clipboard;
    var notify = typeof options.notify === 'function'
      ? function (message) { try { options.notify(message); } catch (_) {} }
      : function () {};
    container.replaceChildren();
    var body = document.createElement('div');
    body.className = 'safe-content-body';
    var toolbar = document.createElement('div');
    toolbar.className = 'safe-content-tools';
    toolbar.appendChild(copyButton(document, 'copy-answer', 'Copiar respuesta', text, body, clipboard, notify, 'Respuesta copiada.'));
    container.appendChild(toolbar);
    container.appendChild(body);
    var lines = text.split('\n');
    var index = 0;
    while (index < lines.length) {
      if (!lineText(lines[index])) { index += 1; continue; }
      var heading = /^(#{1,6})\s+(.+)$/.exec(lineText(lines[index]));
      if (heading) {
        var title = document.createElement('h' + heading[1].length);
        title.textContent = heading[2];
        body.appendChild(title);
        index += 1;
        continue;
      }
      var fence = fenceOpen(lines[index]);
      if (fence) {
        var language = fence[1].trim();
        var codeLines = [];
        index += 1;
        while (index < lines.length && !/^\s*```\s*$/.test(lineText(lines[index]))) {
          codeLines.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) index += 1;
        var pre = document.createElement('pre');
        var code = document.createElement('code');
        var codeText = codeLines.join('\n');
        if (codeText.endsWith('\r')) codeText = codeText.slice(0, -1);
        code.textContent = codeText;
        if (language) code.dataset.language = language;
        pre.appendChild(code);
        var codeBlock = document.createElement('div');
        codeBlock.className = 'safe-code-block';
        codeBlock.appendChild(pre);
        codeBlock.appendChild(copyButton(document, 'copy-code', 'Copiar código', code.textContent, code, clipboard, notify, 'Código copiado.'));
        body.appendChild(codeBlock);
        continue;
      }
      var item = listItem(lines[index]);
      if (item) {
        var list = document.createElement(item.ordered ? 'ol' : 'ul');
        while (index < lines.length) {
          var nextItem = listItem(lines[index]);
          if (!nextItem || nextItem.ordered !== item.ordered) break;
          var entry = document.createElement('li');
          entry.textContent = nextItem.text;
          list.appendChild(entry);
          index += 1;
        }
        body.appendChild(list);
        continue;
      }
      var paragraphLines = [];
      while (index < lines.length && lineText(lines[index]) && !/^(#{1,6})\s+/.test(lineText(lines[index])) && !fenceOpen(lines[index]) && !listItem(lines[index])) {
        paragraphLines.push(lineText(lines[index]));
        index += 1;
      }
      var paragraph = document.createElement('p');
      appendLines(document, paragraph, paragraphLines);
      body.appendChild(paragraph);
    }
    return container;
  }

  return { render: render };
});
