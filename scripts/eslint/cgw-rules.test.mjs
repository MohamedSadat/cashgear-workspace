import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import cgw from './cgw-rules.mjs';

const linter = new Linter({ configType: 'flat' });
const lint = (code) =>
  linter
    .verify(
      code,
      [
        {
          files: ['**/*.tsx'],
          languageOptions: {
            parser: tseslint.parser,
            parserOptions: { ecmaFeatures: { jsx: true } },
          },
          plugins: { cgw },
          rules: { 'cgw/no-untranslated-text': 'error' },
        },
      ],
      'x.tsx',
    )
    .map((message) => message.message);

describe('no-untranslated-text', () => {
  it('reports literal text people read', () => {
    expect(lint('const a = <p>Hello</p>;')).toHaveLength(1);
    expect(lint('const a = <p>مرحبا</p>;')).toHaveLength(1);
    expect(lint('const a = <button aria-label="Close" />;')).toHaveLength(1);
    expect(lint("const a = <input placeholder={'Search'} />;")).toHaveLength(1);
    expect(lint('const a = <img alt={`Cover ${n}`} />;')).toHaveLength(1);
  });

  it('allows translated text, symbols and attributes nobody reads', () => {
    expect(lint("const a = <p>{t('a.b')}</p>;")).toEqual([]);
    expect(lint('const a = <p> · {n} / {m} </p>;')).toEqual([]);
    expect(lint('const a = <div className="cgw-frame" data-testid="host-info" />;')).toEqual([]);
    expect(lint("const a = <button aria-label={t('frame.close')} />;")).toEqual([]);
  });
});
