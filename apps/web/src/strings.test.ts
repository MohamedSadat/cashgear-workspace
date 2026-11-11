import { describe, expect, it } from 'vitest';
import { directionOf, strings } from './strings';

describe('scaffold catalogues', () => {
  it('has the same keys in English and Arabic', () => {
    expect(Object.keys(strings.ar).sort()).toEqual(Object.keys(strings.en).sort());
  });

  it('writes Arabic right to left', () => {
    expect(directionOf('ar')).toBe('rtl');
    expect(directionOf('en')).toBe('ltr');
    expect(strings.ar.host('desktop', '0.0.0')).toBe('سطح المكتب 0.0.0');
  });
});
