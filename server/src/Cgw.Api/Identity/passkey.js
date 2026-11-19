// The passkey ceremonies on the API's own account pages (Phase 11, M11.2; ARCHITECTURE.md,
// Authentication). The pages' only script: served by the API as /account/passkey.js with its
// integrity, under `script-src 'self'` and Trusted Types, so it writes no HTML and runs no string.
//
// Each `form[data-passkey]` names its ceremony (`signin`, `confirm` or `create`) and the address of
// its options (`data-options`, a POST with the antiforgery token as the `data-header` header). The
// browser's answer goes, as WebAuthn's JSON, into the form's hidden `Credential` field and the form
// is posted as any other: the server's answer, its words and where it goes next are the page's.
// What this script says is in the form's `data-msg-*` attributes, in the page's language.
(() => {
  'use strict';

  const supported =
    typeof window.PublicKeyCredential === 'function' &&
    !!navigator.credentials &&
    typeof navigator.credentials.get === 'function';
  for (const element of document.querySelectorAll('[data-passkey-show]'))
    element.hidden = !supported;
  for (const element of document.querySelectorAll('[data-passkey-hide]'))
    element.hidden = supported;
  if (!supported) return;

  const decode = (text) => {
    const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  };

  const encode = (buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  // The browser's JSON readers refuse a member that is null where WebAuthn says "absent".
  const withoutNulls = (value) => {
    if (Array.isArray(value)) return value.map(withoutNulls);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [key, member] of Object.entries(value)) {
        if (member !== null && member !== undefined) out[key] = withoutNulls(member);
      }
      return out;
    }
    return value;
  };

  const creationOptions = (json) => {
    const options = withoutNulls(json);
    if (typeof PublicKeyCredential.parseCreationOptionsFromJSON === 'function') {
      return PublicKeyCredential.parseCreationOptionsFromJSON(options);
    }
    return {
      ...options,
      challenge: decode(options.challenge),
      user: { ...options.user, id: decode(options.user.id) },
      excludeCredentials: (options.excludeCredentials || []).map((c) => ({
        ...c,
        id: decode(c.id),
      })),
    };
  };

  const requestOptions = (json) => {
    const options = withoutNulls(json);
    if (typeof PublicKeyCredential.parseRequestOptionsFromJSON === 'function') {
      return PublicKeyCredential.parseRequestOptionsFromJSON(options);
    }
    return {
      ...options,
      challenge: decode(options.challenge),
      allowCredentials: (options.allowCredentials || []).map((c) => ({ ...c, id: decode(c.id) })),
    };
  };

  // WebAuthn's RegistrationResponseJSON or AuthenticationResponseJSON.
  const answer = (credential) => {
    if (typeof credential.toJSON === 'function') {
      try {
        return credential.toJSON();
      } catch {
        // An older browser's toJSON: made by hand below.
      }
    }
    const r = credential.response;
    const response = { clientDataJSON: encode(r.clientDataJSON) };
    if (r.attestationObject) {
      response.attestationObject = encode(r.attestationObject);
      response.transports = typeof r.getTransports === 'function' ? r.getTransports() : [];
    }
    if (r.authenticatorData) response.authenticatorData = encode(r.authenticatorData);
    if (r.signature) response.signature = encode(r.signature);
    if (r.userHandle) response.userHandle = encode(r.userHandle);
    const json = {
      id: credential.id,
      rawId: encode(credential.rawId),
      type: credential.type,
      response,
      clientExtensionResults: credential.getClientExtensionResults(),
    };
    if (credential.authenticatorAttachment)
      json.authenticatorAttachment = credential.authenticatorAttachment;
    return json;
  };

  // A refusal of the options that the page itself explains once loaded again (signed out, the
  // sign-in no longer recent, the most passkeys an account may have).
  class Reload extends Error {}

  const fetchOptions = async (form) => {
    const token = form.querySelector('input[name="__RequestVerificationToken"]');
    const response = await fetch(form.dataset.options, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { [form.dataset.header]: token ? token.value : '' },
    });
    if (response.status === 401 || response.status === 403 || response.status === 409)
      throw new Reload();
    if (!response.ok) throw new Error('The options were refused');
    return response.json();
  };

  const setUp = (form) => {
    const mode = form.dataset.passkey;
    const button = form.querySelector('[data-passkey-start]');
    const status = document.getElementById(form.dataset.status);
    const say = (text) => {
      if (status) status.textContent = text || '';
    };
    let autofill = null;

    const run = async (conditional) => {
      if (autofill) autofill.abort();
      const controller = new AbortController();
      if (conditional) autofill = controller;
      else {
        say('');
        if (button) button.disabled = true;
      }
      try {
        const json = await fetchOptions(form);
        const credential =
          mode === 'create'
            ? await navigator.credentials.create({
                publicKey: creationOptions(json),
                signal: controller.signal,
              })
            : await navigator.credentials.get({
                publicKey: requestOptions(json),
                signal: controller.signal,
                ...(conditional ? { mediation: 'conditional' } : {}),
              });
        if (!credential) throw new DOMException('No passkey', 'NotAllowedError');
        form.elements.namedItem('Credential').value = JSON.stringify(answer(credential));
        form.submit();
      } catch (error) {
        if (error instanceof Reload) {
          location.reload();
          return;
        }
        if (conditional || (error && error.name === 'AbortError')) return;
        const name = error && error.name;
        say(
          name === 'NotAllowedError'
            ? form.dataset.msgCancelled
            : name === 'InvalidStateError'
              ? form.dataset.msgExists
              : form.dataset.msgFailed,
        );
        if (button) button.disabled = false;
      } finally {
        if (autofill === controller) autofill = null;
      }
    };

    if (button) button.addEventListener('click', () => run(false));
    // Enter in the name field would post the form without an answer.
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      run(false);
    });
    if (
      form.dataset.conditional === 'true' &&
      typeof PublicKeyCredential.isConditionalMediationAvailable === 'function'
    ) {
      PublicKeyCredential.isConditionalMediationAvailable().then(
        (available) => {
          if (available) run(true);
        },
        () => {},
      );
    }
  };

  for (const form of document.querySelectorAll('form[data-passkey]')) setUp(form);
})();
