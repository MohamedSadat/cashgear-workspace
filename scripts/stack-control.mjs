// The e2e server stack's control port (scripts/server-stack.mjs --e2e, 127.0.0.1:5289 or
// CGW_STACK_CONTROL_PORT), for the Phase 6 specs and bench/phase6.mjs: the API process's id, and
// the API recycled mid-session (ended at once and started again; the worker keeps running). A
// stack started before the port existed, or the development stack, has none: the call says so.
export const CONTROL = `http://127.0.0.1:${process.env.CGW_STACK_CONTROL_PORT ?? 5289}`;

async function call(method, path) {
  let response;
  try {
    response = await fetch(`${CONTROL}${path}`, { method, signal: AbortSignal.timeout(240000) });
  } catch {
    throw new Error(
      `No stack control on ${CONTROL}: start the stack with scripts/server-stack.mjs --e2e (a stack started before Phase 6 has none).`,
    );
  }
  if (!response.ok)
    throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

/** The API process: `{ pid, startedAt }`. */
export const apiProcess = () => call('GET', '/api');

/** Ends the API process and starts it again: `{ pid, stoppedAt, startedAt, readyAt }` (ms). */
export const restartApi = () => call('POST', '/api/restart');

/** Whether the stack answering has the control port. */
export async function hasControl() {
  try {
    return (await fetch(`${CONTROL}/api`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}
