// Phase 19's print spike, the parts any machine runs: `--write <folder>` writes the spike's pages
// and images there (the macOS runner prints them with wkwebview.swift); `--judge <folder>` reads
// every `<engine>-<page>-<mode>.pdf` in it and writes its verdicts, with each PDF's first page's
// lines, to `<folder>/verdicts.json`. Spike code: it never ships.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { judge, readPdf } from './check.mjs';
import { SIZES, spikeFiles } from './pages.mjs';

const [mode, folder] = process.argv.slice(2);
if (mode === '--write') {
  mkdirSync(folder, { recursive: true });
  for (const [name, data] of Object.entries(spikeFiles())) writeFileSync(join(folder, name), data);
} else if (mode === '--judge') {
  const verdicts = [];
  for (const file of readdirSync(folder)
    .filter((f) => f.endsWith('.pdf'))
    .sort()) {
    const size = Object.keys(SIZES).find((s) => file.includes(s));
    const read = await readPdf(readFileSync(join(folder, file)));
    const verdict = judge(read, size);
    verdicts.push({
      file,
      ...verdict,
      sizes: [...new Set(read.pages.map((p) => `${Math.round(p.width)}x${Math.round(p.height)}`))],
      first: read.pages[0]?.lines.map((l) => l.text),
      second: read.pages[1]?.lines.slice(0, 3).map((l) => l.text),
    });
    console.log(
      file,
      verdict.pass ? 'pass' : 'FAIL',
      JSON.stringify({ ...verdict, rowsSplit: verdict.rowsSplit.length }),
    );
  }
  writeFileSync(join(folder, 'verdicts.json'), JSON.stringify(verdicts, null, 1));
} else {
  console.error('node bench/print-spike/judge-dir.mjs --write <folder> | --judge <folder>');
  process.exit(2);
}
