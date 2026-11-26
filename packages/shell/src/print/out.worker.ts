// Phase 19: a page out written off the main thread (ARCHITECTURE.md, "Word, PDF and print"), so
// typing on another page goes on as it was. After 0.19.0 the pages are read here too: their stored
// logs come in (`read`), each is replayed and walked here, and only what the main thread must
// resolve goes back; then, with what it resolved (`make`), the Word file's bytes or the print
// view's HTML are made here and go back (assemble.ts's `outWork`). The shell keeps the worker for
// the next page out for a minute (collect.ts's `outWorker`).
import { outWork, type OutRequest } from './assemble';

const work = outWork();

self.onmessage = (event: MessageEvent<OutRequest>) => {
  const done = work(event.data);
  if (done) self.postMessage(done.answer, { transfer: done.transfer });
};
