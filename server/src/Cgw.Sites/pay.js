// The pay page's one script of its own (Phase 18): Paddle.js, loaded before it, is initialised with
// the client-side token, and opens Paddle's checkout for the transaction its address names (`_ptxn`).
// The page then says the payment was received, or that the checkout was closed. Nothing else.
(function () {
  var self = document.currentScript;
  var state = document.getElementById('state');
  var done = false;
  function say(key) {
    if (state) state.textContent = state.getAttribute(key) || state.textContent;
  }
  if (!self || !window.Paddle) return;
  if (self.getAttribute('data-sandbox') === '1') window.Paddle.Environment.set('sandbox');
  window.Paddle.Initialize({
    token: self.getAttribute('data-token'),
    checkout: { settings: { displayMode: 'overlay', locale: self.getAttribute('data-locale') || 'en' } },
    eventCallback: function (event) {
      if (!event || !event.name) return;
      if (event.name === 'checkout.completed') {
        done = true;
        say('data-done');
      } else if (event.name === 'checkout.closed' && !done) {
        say('data-closed');
      }
    },
  });
})();
