// Order keys: an in-house fractional index (D19). Siblings sort by (order key, id) in binary
// order, so a key between any two neighbours always exists and nothing else is renumbered.
//
// A key is an integer part and a fraction. The integer part's first character gives its length
// ('a'..'z' for 2..27 characters going up, 'Z'..'A' for 2..27 going down); the fraction has no
// trailing zero. The digits are base 62 in ASCII order, so string order is key order. The shared
// test vectors (order-vectors.json) let the C# server check the same answers in Phase 2.

export const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ZERO = 'a0';
const SMALLEST = 'A' + '0'.repeat(26);

const digit = (char: string) => {
  const value = DIGITS.indexOf(char);
  if (value < 0) throw new Error(`Not an order-key digit: ${char}`);
  return value;
};

/** A fraction strictly between a and b (b null means "after a"); neither ends in 0. */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`${a} >= ${b}`);
  if (a.endsWith('0') || (b !== null && b.endsWith('0'))) throw new Error('Trailing zero');
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const low = a ? digit(a[0]) : 0;
  const high = b !== null ? digit(b[0]) : DIGITS.length;
  if (high - low > 1) return DIGITS[Math.round((low + high) / 2)];
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[low] + midpoint(a.slice(1), null);
}

function integerLength(head: string): number {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 'a'.charCodeAt(0) + 2;
  if (head >= 'A' && head <= 'Z') return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2;
  throw new Error(`Not an order-key head: ${head}`);
}

function integerPart(key: string): string {
  const length = integerLength(key[0]);
  if (length > key.length) throw new Error(`Order key too short: ${key}`);
  return key.slice(0, length);
}

/** Throws unless `key` is a key this module could have made. */
export function validateOrderKey(key: string): void {
  if (key === SMALLEST) throw new Error('The smallest integer is not a key');
  const integer = integerPart(key);
  for (const char of key) digit(char);
  if (key.slice(integer.length).endsWith('0')) throw new Error(`Trailing zero: ${key}`);
}

export const isOrderKey = (key: unknown): key is string => {
  if (typeof key !== 'string' || !key) return false;
  try {
    validateOrderKey(key);
    return true;
  } catch {
    return false;
  }
};

function increment(integer: string): string | null {
  const [head, ...digits] = integer.split('');
  let carry = true;
  for (let i = digits.length - 1; carry && i >= 0; i--) {
    const next = digit(digits[i]) + 1;
    if (next === DIGITS.length) digits[i] = '0';
    else {
      digits[i] = DIGITS[next];
      carry = false;
    }
  }
  if (!carry) return head + digits.join('');
  if (head === 'Z') return ZERO;
  if (head === 'z') return null;
  const nextHead = String.fromCharCode(head.charCodeAt(0) + 1);
  if (nextHead > 'a') digits.push('0');
  else digits.pop();
  return nextHead + digits.join('');
}

function decrement(integer: string): string | null {
  const [head, ...digits] = integer.split('');
  let borrow = true;
  for (let i = digits.length - 1; borrow && i >= 0; i--) {
    const next = digit(digits[i]) - 1;
    if (next === -1) digits[i] = DIGITS[DIGITS.length - 1];
    else {
      digits[i] = DIGITS[next];
      borrow = false;
    }
  }
  if (!borrow) return head + digits.join('');
  if (head === 'a') return 'Z' + DIGITS[DIGITS.length - 1];
  if (head === 'A') return null;
  const nextHead = String.fromCharCode(head.charCodeAt(0) - 1);
  if (nextHead < 'Z') digits.push(DIGITS[DIGITS.length - 1]);
  else digits.pop();
  return nextHead + digits.join('');
}

/** A key that sorts strictly between a and b; null means the start or the end of the list. */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null) validateOrderKey(a);
  if (b !== null) validateOrderKey(b);
  if (a !== null && b !== null && a >= b) throw new Error(`${a} >= ${b}`);
  if (a === null) {
    if (b === null) return ZERO;
    const ib = integerPart(b);
    const fb = b.slice(ib.length);
    if (ib === SMALLEST) return ib + midpoint('', fb);
    if (ib < b) return ib;
    const lower = decrement(ib);
    if (lower === null) throw new Error('No key before the smallest');
    // The smallest integer is not a key by itself; give it a fraction.
    return lower === SMALLEST ? lower + midpoint('', null) : lower;
  }
  if (b === null) {
    const ia = integerPart(a);
    const higher = increment(ia);
    return higher === null ? ia + midpoint(a.slice(ia.length), null) : higher;
  }
  const ia = integerPart(a);
  const fa = a.slice(ia.length);
  const ib = integerPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) return ia + midpoint(fa, fb);
  const higher = increment(ia);
  if (higher === null) throw new Error('No key after the largest');
  if (higher < b) return higher;
  return ia + midpoint(fa, null);
}

/** n keys in order, strictly between a and b, spread so later inserts stay short. */
export function keysBetween(a: string | null, b: string | null, n: number): string[] {
  if (n <= 0) return [];
  if (n === 1) return [keyBetween(a, b)];
  if (b === null) {
    const out: string[] = [];
    let last = a;
    for (let i = 0; i < n; i++) out.push((last = keyBetween(last, null)));
    return out;
  }
  if (a === null) {
    const out: string[] = [];
    let last = b;
    for (let i = 0; i < n; i++) out.unshift((last = keyBetween(null, last)));
    return out;
  }
  const middle = Math.floor(n / 2);
  const mid = keyBetween(a, b);
  return [...keysBetween(a, mid, middle), mid, ...keysBetween(mid, b, n - middle - 1)];
}

/** The order siblings are drawn in: order key, then id, both by code unit (binary collation). */
export function compareSiblings(
  a: { orderKey: string; id: string },
  b: { orderKey: string; id: string },
): number {
  if (a.orderKey !== b.orderKey) return a.orderKey < b.orderKey ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
