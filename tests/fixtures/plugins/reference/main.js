// The reference plugin's side of plugin-frame.1 (Phase 10): it says `ready` to its parent, takes
// one `init` (only from `window.parent`, with a port: never from another frame), then speaks on the
// port only. It shows what it was given and nothing else; its one write is its own props, raised
// by its button. Every message it did not take is counted in #state.foreign, so a spec can see a
// hostile frame's messages arrived and changed nothing.
(function () {
  'use strict';
  var WORDS = {
    en: {
      title: 'Notes',
      starting: 'Starting…',
      ready: 'Ready',
      readOnly: 'Read only',
      newer: 'Read only: a newer version wrote this block',
      count: 'Count',
      add: 'Add one',
      rows: 'Rows',
      noRows: 'No view chosen',
      of: ' of ',
    },
    ar: {
      title: 'ملاحظات',
      starting: 'جارٍ البدء…',
      ready: 'جاهزة',
      readOnly: 'للقراءة فقط',
      newer: 'للقراءة فقط: كتب هذه الكتلة إصدار أحدث',
      count: 'العدد',
      add: 'أضف واحدًا',
      rows: 'الصفوف',
      noRows: 'لم يُختر عرض',
      of: ' من ',
    },
  };
  var state = {
    inited: false,
    plugin: null,
    block: null,
    props: {},
    theme: null,
    direction: null,
    language: 'en',
    rows: null,
    answers: [],
    foreign: 0,
    messages: 0,
  };
  var port = null;
  var $ = function (id) {
    return document.getElementById(id);
  };

  function words() {
    return WORDS[state.language] || WORDS.en;
  }

  function draw() {
    var w = words();
    var root = document.documentElement;
    root.lang = state.language;
    root.dir = state.direction || 'ltr';
    if (state.theme) root.dataset.theme = state.theme;
    document.title = w.title;
    var editable = !!(state.block && state.block.editable && !state.block.newer);
    $('status').textContent = !state.inited
      ? w.starting
      : state.block && state.block.newer
        ? w.newer
        : editable
          ? w.ready
          : w.readOnly;
    $('count-label').textContent = w.count;
    var count = typeof state.props.count === 'number' ? state.props.count : 0;
    $('count').textContent = String(count);
    $('add').textContent = w.add;
    $('add').disabled = !editable;
    $('note').textContent = typeof state.props.note === 'string' ? state.props.note : '';
    var table = $('rows');
    var body = table.querySelector('tbody');
    while (body.firstChild) body.removeChild(body.firstChild);
    if (state.rows) {
      table.hidden = false;
      $('rows-caption').textContent =
        w.rows + ' (' + state.rows.rows.length + w.of + state.rows.total + ')';
      state.rows.rows.slice(0, 20).forEach(function (row) {
        var tr = document.createElement('tr');
        var td = document.createElement('td');
        td.textContent = row.title;
        td.dir = 'auto';
        tr.appendChild(td);
        body.appendChild(tr);
      });
    } else {
      table.hidden = true;
    }
    $('state').textContent = JSON.stringify({
      inited: state.inited,
      plugin: state.plugin,
      block: state.block,
      props: state.props,
      theme: state.theme,
      direction: state.direction,
      language: state.language,
      rows: state.rows && {
        databaseId: state.rows.databaseId,
        viewId: state.rows.viewId,
        properties: state.rows.properties.map(function (p) {
          return { id: p.id, type: p.type };
        }),
        titles: state.rows.rows.map(function (r) {
          return r.title;
        }),
        values: state.rows.rows.map(function (r) {
          return r.values;
        }),
        total: state.rows.total,
        complete: state.rows.complete,
      },
      answers: state.answers,
      foreign: state.foreign,
      messages: state.messages,
    });
    resize();
  }

  function resize() {
    if (!port) return;
    port.postMessage({ type: 'resize', height: Math.ceil(document.documentElement.scrollHeight) });
  }

  function onPort(event) {
    var data = event.data;
    if (!data || typeof data.type !== 'string') return;
    state.messages++;
    switch (data.type) {
      case 'props':
        state.props = data.props || {};
        break;
      case 'theme':
        state.theme = data.theme;
        state.direction = data.direction;
        state.language = data.language;
        break;
      case 'editable':
        state.block = {
          version: state.block ? state.block.version : null,
          editable: data.editable,
          newer: data.newer,
        };
        break;
      case 'rows':
        state.rows = data.rows;
        break;
      case 'saved':
        state.answers.push('saved');
        break;
      case 'refused':
        state.answers.push('refused ' + data.code);
        break;
      default:
        return;
    }
    draw();
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    // `init` only from the page that holds this frame, with a port, and only once.
    if (
      state.inited ||
      event.source !== window.parent ||
      !data ||
      data.type !== 'init' ||
      data.contract !== 'plugin-frame.1' ||
      !event.ports ||
      !event.ports[0]
    ) {
      state.foreign++;
      draw();
      return;
    }
    state.inited = true;
    port = event.ports[0];
    port.onmessage = onPort;
    state.plugin = data.plugin;
    state.block = data.block;
    state.props = data.props || {};
    state.theme = data.theme;
    state.direction = data.direction;
    state.language = data.language;
    state.rows = data.rows;
    draw();
  });

  $('add').addEventListener('click', function () {
    if (!port) return;
    var next = {};
    for (var key in state.props) next[key] = state.props[key];
    next.count = (typeof state.props.count === 'number' ? state.props.count : 0) + 1;
    state.props = next;
    draw();
    port.postMessage({ type: 'setProps', props: next });
  });

  if (typeof ResizeObserver === 'function') new ResizeObserver(resize).observe(document.body);
  draw();
  window.parent.postMessage({ type: 'ready', contracts: ['plugin-frame.1'] }, '*');
})();
