import { describe, expect, it } from 'vitest';
import { shareInFlight } from './shared';

/** An ask the test answers by hand, counting how often it was made. */
function manual<T>() {
  const asks: { resolve: (value: T) => void; reject: (error: unknown) => void }[] = [];
  const ask = () =>
    new Promise<T>((resolve, reject) => {
      asks.push({ resolve, reject });
    });
  return { ask, asks };
}

describe('shareInFlight', () => {
  it('gives callers at once one ask and its answer', async () => {
    const { ask, asks } = manual<string | null>();
    const token = shareInFlight(ask);
    const answers = Promise.all([token(), token(), token()]);
    expect(asks).toHaveLength(1);
    asks[0].resolve('t1');
    expect(await answers).toEqual(['t1', 't1', 't1']);
  });

  it('asks again once the last ask has settled', async () => {
    const { ask, asks } = manual<string | null>();
    const token = shareInFlight(ask);
    const first = token();
    asks[0].resolve(null);
    expect(await first).toBeNull();
    const second = token();
    expect(asks).toHaveLength(2);
    asks[1].resolve('t2');
    expect(await second).toBe('t2');
  });

  it('gives every caller at once the error, and asks again after it', async () => {
    const { ask, asks } = manual<string | null>();
    const token = shareInFlight(ask);
    const both = Promise.allSettled([token(), token()]);
    expect(asks).toHaveLength(1);
    asks[0].reject(new Error('offline'));
    const settled = await both;
    expect(settled.map((s) => s.status)).toEqual(['rejected', 'rejected']);
    const next = token();
    expect(asks).toHaveLength(2);
    asks[1].resolve('t3');
    expect(await next).toBe('t3');
  });
});
