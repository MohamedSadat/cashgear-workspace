// Pure license-policy logic for npm packages, shared by check-licenses.mjs and
// its unit tests. Licenses are SPDX expressions: `A OR B` passes when either side
// passes, `A AND B` only when both do, and `A WITH B` is matched as one license.

function tokenize(expression) {
  return expression.replace(/\(/g, ' ( ').replace(/\)/g, ' ) ').trim().split(/\s+/).filter(Boolean);
}

/** Parses an SPDX expression into a tree of { or }, { and } and license strings. */
export function parseSpdx(expression) {
  const tokens = tokenize(expression);
  let index = 0;
  function primary() {
    const token = tokens[index++];
    if (token === '(') {
      const inner = or();
      if (tokens[index++] !== ')') throw new Error('Unbalanced SPDX expression: ' + expression);
      return inner;
    }
    if (!token || token === ')' || /^(AND|OR|WITH)$/i.test(token))
      throw new Error('Invalid SPDX expression: ' + expression);
    if (tokens[index]?.toUpperCase() === 'WITH') {
      index++;
      return token + ' WITH ' + tokens[index++];
    }
    return token;
  }
  function and() {
    const terms = [primary()];
    while (tokens[index]?.toUpperCase() === 'AND') {
      index++;
      terms.push(primary());
    }
    return terms.length === 1 ? terms[0] : { and: terms };
  }
  function or() {
    const terms = [and()];
    while (tokens[index]?.toUpperCase() === 'OR') {
      index++;
      terms.push(and());
    }
    return terms.length === 1 ? terms[0] : { or: terms };
  }
  const tree = or();
  if (index !== tokens.length) throw new Error('Invalid SPDX expression: ' + expression);
  return tree;
}

/** True when some choice of alternatives uses only licenses `accept` approves. */
export function satisfiable(expression, accept) {
  let tree;
  try {
    tree = parseSpdx(expression);
  } catch {
    return false;
  }
  const visit = (node) =>
    typeof node === 'string' ? accept(node) : node.or ? node.or.some(visit) : node.and.every(visit);
  return visit(tree);
}

function matchesException(entry, exception) {
  if (exception.license && exception.license !== entry.license) return false;
  if (exception.package) return entry.name === exception.package;
  if (exception.packagePrefix) return entry.name.startsWith(exception.packagePrefix);
  return false;
}

/** Flattens `pnpm licenses list --json` output into one entry per package. */
export function entries(listing) {
  return Object.entries(listing).flatMap(([license, packages]) =>
    packages.map((pkg) => ({
      name: pkg.name,
      versions: pkg.versions ?? [],
      license: pkg.license ?? license,
    })),
  );
}

/**
 * Shipped (production) packages must use allowed licenses; every package,
 * development tools included, must avoid the denied ones.
 * Returns a list of human-readable violations.
 */
export function checkListings({ shipped, all }, policy) {
  const violations = [];
  const isDenied = (id) => policy.deny.some((prefix) => id.startsWith(prefix));
  const shippedEntries = entries(shipped);
  for (const entry of shippedEntries) {
    if (policy.exceptions.some((exception) => matchesException(entry, exception))) continue;
    if (!satisfiable(entry.license, (id) => policy.allow.includes(id)))
      violations.push(
        entry.name +
          '@' +
          entry.versions.join(',') +
          ' ships under ' +
          entry.license +
          ', which is not allowed',
      );
  }
  for (const entry of entries(all)) {
    if (policy.exceptions.some((exception) => matchesException(entry, exception))) continue;
    if (!satisfiable(entry.license, (id) => !isDenied(id)))
      violations.push(
        entry.name +
          '@' +
          entry.versions.join(',') +
          ' uses ' +
          entry.license +
          ', which is denied',
      );
  }
  const names = new Set(shippedEntries.map((entry) => entry.name));
  for (const name of policy.mustInclude)
    if (!names.has(name))
      violations.push(
        name + ' is missing from the shipped listing, so the license walk is incomplete',
      );
  return violations;
}
