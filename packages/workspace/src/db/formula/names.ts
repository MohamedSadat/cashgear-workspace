// Formulas are stored with properties named by id, `prop("Ab12Cd34")`, so a rename touches one
// record; the editor shows and takes names, `prop("Price")`. Only the text inside `prop("...")`
// changes; the rest of the expression is kept as written. An expression that does not tokenise is
// returned as it is.
import type { DatabaseRecord, PropertyDef } from '../types';
import { tokenize, type Token } from './parser';

const quote = (text: string) => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function rewrite(expression: string, replace: (value: string) => string | undefined): string {
  let tokens: Token[];
  try {
    tokens = tokenize(expression);
  } catch {
    return expression;
  }
  let out = '';
  let last = 0;
  for (let i = 0; i + 3 < tokens.length; i++) {
    const [name, open, arg, close] = tokens.slice(i, i + 4);
    if (name.kind !== 'name' || name.text !== 'prop') continue;
    if (open.text !== '(' || arg.kind !== 'string' || close.text !== ')') continue;
    const next = replace(arg.value as string);
    if (next === undefined) continue;
    out += expression.slice(last, arg.start) + quote(next);
    last = arg.end;
  }
  return out + expression.slice(last);
}

/** `prop("id")` as `prop("Name")`; ids the database does not have stay as they are. */
export function formulaToNames(database: DatabaseRecord, expression: string): string {
  const byId = new Map<string, PropertyDef>();
  for (const def of database.properties) if (!byId.has(def.id)) byId.set(def.id, def);
  return rewrite(expression, (id) => byId.get(id)?.name);
}

/**
 * `prop("Name")` as `prop("id")`: the first property with that name in database order, one not
 * deleted before a deleted one; a text that is already an id of the database stays; anything else
 * stays as written (the checker then says `formula.unknownProperty`).
 */
export function formulaToIds(database: DatabaseRecord, expression: string): string {
  const live = database.properties.filter((def) => !def.trashedAt);
  const trashed = database.properties.filter((def) => def.trashedAt);
  return rewrite(expression, (name) => {
    const def = live.find((d) => d.name === name) ?? trashed.find((d) => d.name === name);
    if (def) return def.id;
    return undefined;
  });
}
