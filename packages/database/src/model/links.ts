// URL, email and phone cells are links only when they pass the scheme allow-list (ARCHITECTURE.md,
// Links: checked when parsed, drawn and clicked). A URL cell links `http:` and `https:` (a bare
// host gets `https://`), an email `mailto:`, a phone `tel:`; anything else is shown as text.
import type { PropertyType } from '../core';

// Control characters inside a scheme are how `java\tscript:` gets past a check.
const CONTROL = {
  test(value: string) {
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code < 0x20 || code === 0x7f) return true;
    }
    return false;
  },
};
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const HOST_LIKE = /^[\p{L}\p{N}][\p{L}\p{N}.-]*\.[\p{L}]{2,}(?::\d{1,5})?(?:[/?#]|$)/u;
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;
const PHONE = /^\+?[\d\s().-]{3,32}$/;

/** The link a URL cell's text opens, or null when it is not a safe web link. */
export function safeUrl(text: string): string | null {
  const value = text.trim();
  if (!value || CONTROL.test(value) || /\s/.test(value)) return null;
  const scheme = SCHEME.exec(value)?.[1]?.toLowerCase();
  if (scheme === 'http' || scheme === 'https') {
    try {
      const url = new URL(value);
      return url.hostname ? url.href : null;
    } catch {
      return null;
    }
  }
  // `localhost:3000` reads as a scheme; only text with no scheme at all may be a bare host.
  if (scheme && !HOST_LIKE.test(value)) return null;
  if (!HOST_LIKE.test(value)) return null;
  try {
    return new URL(`https://${value}`).href;
  } catch {
    return null;
  }
}

/** `mailto:` for a well-formed address, else null. */
export function safeEmail(text: string): string | null {
  const value = text.trim();
  if (!value || CONTROL.test(value) || !EMAIL.test(value)) return null;
  return `mailto:${value}`;
}

/** `tel:` with only the digits and a leading plus, else null. */
export function safePhone(text: string): string | null {
  const value = normaliseDigits(text.trim());
  if (!value || !PHONE.test(value)) return null;
  const digits = value.replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
  return digits.replace(/\+/g, '').length >= 3 ? `tel:${digits}` : null;
}

export function linkFor(type: PropertyType, text: string): string | null {
  if (type === 'url') return safeUrl(text);
  if (type === 'email') return safeEmail(text);
  if (type === 'phone') return safePhone(text);
  return null;
}

/** Arabic-Indic and Eastern Arabic-Indic digits as ASCII digits, as people type them. */
export function normaliseDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (d) => {
    const code = d.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}
