# The database grid with a screen reader

The script a person follows by hand with each screen reader, once a release from 0.12.0
(`DECISIONS.md`, 2026-11-19: Phase 12, "Screen readers"): NVDA and Narrator on Windows, VoiceOver
on a Mac. It proves Phase 12's acceptance criterion: each reader reads a row's title, its position
of the true total and the column as one moves, and says when editing starts, is saved and is
cancelled.

What the readers are given is checked in CI on every run, from Chromium's own accessibility tree
(`tests/e2e/grid-a11y.spec.ts`, in Chrome and Edge): the counts, indices, roles, names, levels and
the live region's words. What a reader then says cannot be read there; this script is for that.

## What the grid gives a screen reader

- **The table** is a `grid` named "<database>: table" and described by its foot ("Rows: 300", or
  "Rows: 100 of 5200" while a server's rows load). Its row count is the header and the rows the
  query matches, however many are loaded or drawn: 301 for 300 rows.
- **Each row** has its place of that total: the header is row 1, the first row is row 2, and the
  300th is row 301, as the virtual window scrolls. "Load more" stands where the next row will be;
  the "New" line at the end is not a row (the reader hears it through the live region).
- **The title** is each row's header (`rowheader`), named by the title alone; every other cell is a
  grid cell. A reader names the row by its title as one moves down a column.
- **The column headers** are named by the property's name ("Size"); the type ("Number") is the
  header's description.
- **A grouped table** is a `treegrid`: each group is a row at level 1, expanded or collapsed, its
  place among the groups and its count ("Not started Rows: 2"); its rows are at level 2 with their
  place in the group of its count ("2 of 7"). In a tree grid each group's header is a row too, so
  the row numbers count the groups' headers as well; a row's place in its group is what level 2's
  "x of y" says. Left collapses a group and Right expands it (mirrored in Arabic), as Enter and
  Space toggle it.
- **The live region** (polite) says "Editing: Size, Item 0300." when editing starts, "Saved: Size,
  Item 0300." when the value is written, "Edit cancelled: Size, Item 0300." when it is not, and
  "New row: press Enter to add one." on the New line. In Arabic: «تحرير: …», «حُفظ: …»,
  «أُلغي التحرير: …», «صف جديد: اضغط Enter لإضافة صف.».

## Setting up

1. Build and start the app: `pnpm build`, then `pnpm preview` (the web app on
   `http://127.0.0.1:4273`); for the server's table also `pnpm dev:server`. On the Mac, the
   desktop app built by `node scripts/macos-build.mjs`, or the web app in Safari.
2. Make the test files (in any folder):

   ```sh
   node -e "const r=(n)=>['Name,Size',...Array.from({length:n},(_,i)=>'Item '+String(i+1).padStart(4,'0')+','+(i+1))].join('\r\n')+'\r\n';require('fs').writeFileSync('Ledger.csv',r(300));require('fs').writeFileSync('Stock.csv',r(5200))"
   ```

3. **The local table** (300 rows): a new workspace on this device ("Create workspace"), then the
   sidebar's ▦ → "Import a CSV file as a new database" → `Ledger.csv` → Import → Close. The
   database "Ledger" opens on its page.
4. **The server's table** (5,200 rows, more than the 5,000 a device queries itself): signed in,
   ▦ → New database → "Empty database", titled "Stock"; add a Number property "Size" from the
   header's ＋; View options (⋯) → "Import CSV…" → `Stock.csv` → Import (the server imports it) →
   Close; reload the page.
5. **The grouped table**: ▦ → New database → Tasks → Create; ＋ (Add a view) → Table; Group →
   Group by: Priority; Escape.
6. The readers:
   - **NVDA** (Chrome or Edge): NVDA menu → Tools → Speech Viewer, kept open beside the browser;
     Preferences → Settings → Document Formatting → Tables: "Rows and columns" for headers and
     "Cell coordinates" on. NVDA goes to focus mode by itself when the grid takes the focus.
   - **Narrator** (Edge or Chrome): Narrator key (Caps Lock or Insert) + Space turns scan mode off
     once the grid has the focus, so the arrows reach the grid.
   - **VoiceOver** (Safari, or the desktop app): VO = Control+Option; Quick Nav off (Left and Right
     arrows together), so the arrows reach the grid; VO+F3 reads the item under the cursor.

## The script

Tab into the table from the toolbar's search box (or click a cell). Each step: the keys, then what
the reader must say (in its own order and words; each listed part must be there).

### A. The local table ("Ledger", 300 rows)

| Step | Keys | Must say |
| --- | --- | --- |
| A1 | Tab into the table | "Ledger: table", grid or table, "Rows: 300" (its description), 301 rows and 2 columns where the reader says counts; the cell: "Item 0001", row 2, column 1 or "Name" |
| A2 | Down | "Item 0002", row 3 (of 301) |
| A3 | Right | "2", column 2 or "Size"; the row's header "Item 0002" where the reader says row headers |
| A4 | Page Down | a row "Item 00NN" at row NN+1, its Size |
| A5 | Left, then Control+Down | "New row: press Enter to add one." (the New line; the grid itself may be said first) |
| A6 | Up | "Item 0300", row 301 (of 301) |
| A7 | Control+Home (the header "Name"), then Right | "Size", column header, "Number" (its description) where the reader says descriptions |
| A8 | Control+End (the New line, last column), Up, Enter | "Editing: Size, Item 0300." and the edit field |
| A9 | Escape | "Edit cancelled: Size, Item 0300." |
| A10 | Enter, type 3000, Enter | "Saved: Size, Item 0300." and the cell's new value |
| A11 | Left, Enter, type a new title, Enter | "Editing: Name, Item 0300." then "Saved: Name, <the new title>." |
| A12 | Down, Enter | "New row: press Enter to add one." then "Editing: Name, Untitled." |
| A13 | Escape | "Edit cancelled: Name, Untitled."; the table now has 302 rows |

### B. The server's table ("Stock", 5,200 rows)

| Step | Keys | Must say |
| --- | --- | --- |
| B1 | Tab into the table | "Stock: table", "Rows: 100 of 5200", 5,201 rows where the reader says counts; "Item 0001", row 2 |
| B2 | Control+Down | the New line, then (the next rows loaded) "Item 0102", row 103 (of 5,201) |
| B3 | Down | "Item 0103", row 104 |
| B4 | Page Down a few times | each row at its title's number plus one, of 5,201 |

### C. The grouped table (Tasks, grouped by Priority)

| Step | Keys | Must say |
| --- | --- | --- |
| C1 | Tab into the table | tree grid (or "tree view", "outline"), "Tasks: table"; the first group: "No Priority Rows: 0", expanded, level 1, 1 of 4 |
| C2 | Down until a group with rows, then Down | the group's header ("High Rows: N", level 1, 2 of 4); then its first row: the title, level 2, 1 of N |
| C3 | Up to the group's header, Left | collapsed |
| C4 | Right | expanded |
| C5 | Down past the group's last row | "New row in <the group>: press Enter to add one." |

### D. Arabic (optional, NVDA or Narrator)

Settings → Language → العربية; repeat A1 to A3 and A8 to A10 (Right and Left are mirrored: Left
goes to the next column). The reader must say the Arabic words: «Ledger: جدول», «الصفوف: 300»,
«تحرير: Size، Item 0300.», «حُفظ: …», «أُلغي التحرير: …».

## Results

One table per run. Mark each step pass, or fail with what was said (NVDA's Speech Viewer can be
copied).

| Reader | Version | Browser or app, version | System | Date | By | Steps passed | Failed steps and what was said |
| --- | --- | --- | --- | --- | --- | --- | --- |
| NVDA | | | Windows | | | | |
| Narrator | | | Windows | | | | |
| VoiceOver | | | macOS | | | | |
