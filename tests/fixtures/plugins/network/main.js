// The networked plugin's attempts (tests/fixtures/plugins/network, Phase 13). On `init` it posts the
// titles of the rows it is shown (none when its block names no view) to each target and records
// `reached` when an answer came back, `blocked` when the browser stopped the request. The plugins
// origin's CSP decides: only the hosts an owner or admin approved are reachable. The outcomes go back
// as this plugin's props (`attempts`, and `round`, raised each time it is drawn), so a spec can read
// them without the frame.
(function () {
  'use strict';
  var TARGETS = {
    approved: 'http://localhost:4288/echo',
    other: 'http://127.0.0.1:4288/echo',
    unnamed: 'https://example.com/echo',
  };
  var port = null;

  function record(name, outcome) {
    var li = document.createElement('li');
    li.dataset.attempt = name;
    li.dataset.outcome = outcome;
    li.textContent = name + ': ' + outcome;
    document.getElementById('attempts').appendChild(li);
  }

  function attempt(name, url, body) {
    return window
      .fetch(url + '?target=' + name, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: body,
      })
      .then(
        function (answer) {
          return answer.ok ? 'reached' : 'blocked';
        },
        function () {
          return 'blocked';
        },
      )
      .then(function (outcome) {
        record(name, outcome);
        return [name, outcome];
      });
  }

  function run(init) {
    var rows = init.rows && init.rows.rows ? init.rows.rows : [];
    var titles = rows.map(function (row) {
      return row.title;
    });
    var body = JSON.stringify({ titles: titles, version: init.plugin.version });
    var round = (typeof init.props.round === 'number' ? init.props.round : 0) + 1;
    Promise.all(
      Object.keys(TARGETS).map(function (name) {
        return attempt(name, TARGETS[name], body);
      }),
    ).then(function (results) {
      var attempts = {};
      results.forEach(function (pair) {
        attempts[pair[0]] = pair[1];
      });
      document.getElementById('summary').textContent = 'Done';
      document.getElementById('summary').dataset.done = 'true';
      if (init.block.editable && !init.block.newer)
        port.postMessage({
          type: 'setProps',
          props: { attempts: attempts, round: round, version: init.plugin.version },
        });
    });
  }

  window.addEventListener('message', function (event) {
    if (port || event.source !== window.parent || !event.data || event.data.type !== 'init') return;
    if (!event.ports || !event.ports[0]) return;
    port = event.ports[0];
    port.onmessage = function () {};
    port.postMessage({ type: 'resize', height: Math.ceil(document.documentElement.scrollHeight) });
    run(event.data);
  });
  window.parent.postMessage({ type: 'ready', contracts: ['plugin-frame.1'] }, '*');
})();
