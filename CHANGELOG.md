# Changelog

Every release of Cash Gear Workspace, newest first. Versions follow semantic versioning, with one
version across the app, its crates and its packages. The release workflow takes each release's
notes from its section here.

## [0.9.0] - 2026-11-18

Publish a page and the pages under it as a public site, plan with a timeline over any database,
and keep your workbooks in your export, with their history.

- **Publish to the web.** In a page's Share dialog, "Publish to the web" lists what will be
  published, and how many restricted or hidden pages are left out, before anything is public;
  then the page and the pages under it read at `pages.cashgearerp.com/<address>` with no account
  and no script, in English or Arabic, light or dark as the reader's system is. Databases show
  their rows through the block's own view, and charts and boards are drawn from them; workbooks
  and ERP data show a placeholder; comments, history and people's names are never on a site.
  Unpublish takes every address down within a minute, and search engines stay away unless you turn
  indexing on. Only someone with full access to a page can publish it, and owners and admins can
  turn publishing off for a workspace in Settings, which takes all its sites down at once.
- **Databases on share links.** A page shared by link now shows its databases' rows, read-only,
  through each block's view (a hidden column never leaves the server), with charts and boards
  drawn from them; a database's own page shows its views.
- **Timeline view.** A sixth view for databases: each row a bar from a date, or from a start and an
  end date, by day, week, month or quarter, in lanes by a select or status. Drag a bar to move it
  or its ends to change its dates, or use the keyboard (Alt and an arrow move it a day; Alt,
  Shift and an arrow its end; Ctrl, Shift and an arrow its start). Rows without a date wait
  beside it and take the day you drop them on. In Arabic, time runs from right to left. A
  timeline or a calendar over a
  large database asks the server only for the days it shows, so the calendar's 5,000-row limit is
  gone. The Projects template's Timeline is now a timeline.
- **Workbooks.** A workbook's version history (from the workbook list or a sheet block's menu)
  shows each kept version with when and by whom: open one read-only, or, with edit access,
  restore it as the newest. The workspace's export now holds the workbooks you can read;
  importing it while signed in puts the new workspace in your account with its workbooks, and an
  import on this device alone says how many it skipped. On the desktop, "Open in Cash Gear Sheet"
  opens Cash Gear Sheet's desktop app when it is installed, and its web app otherwise.
- **Older versions.** 0.8.0 and earlier show a timeline view as a table, and changing it there
  leaves it a timeline here.
- **Fixed.** An import's report (what it made and what it skipped) now shows after the new
  workspace opens.
- **For whoever runs the server.** A third process serves the sites: `sites/` in the deploy
  package, its own IIS site at `pages.cashgearerp.com` with read-only database access. Add its DNS
  record and certificate and run `install.ps1` (`-SitesHostName pages.cashgearerp.com`, the
  default). The API needs `Sites__PublicUrl` (an https address in Production, or it does not
  start). The update adds the published sites table, each workspace's publishing switch and the
  launch ticket's target (`docs/OPERATIONS.md`).

## [0.8.0] - 2026-11-16

Bring work in from Notion, Markdown and Word, edit many cells at once, get an email when someone
mentions you, and lose nothing the app said was saved, even when the browser crashes.

- **Nothing saved is lost.** Chrome can drop writes it reported complete after a crash at the
  wrong moment, and sometimes deletes a site's whole local store; on the web the app now keeps a
  second copy of everything typed and not yet on the server, and puts back what Chrome lost the
  next time it opens. What this device makes is also written with strict durability, so an
  operating-system crash or a power cut loses nothing "Saved" covered.
- **Cells in bulk.** In a database's table, select a rectangle of cells with Shift and the arrow
  keys, Shift and a click, or by dragging; whole rows and columns too, right to left in Arabic.
  Copy it into Excel or Cash Gear Sheet as shown, or paste from them: numbers, currencies,
  percents and dates are read as your device writes them, people by their email. A paste past the
  last row adds rows (at most 1,000), cells that cannot take a value are left as they were and
  counted, and the notice after a paste or a clear offers Undo. Delete clears a selection.
- **Order of your own.** Drag a board's columns, or a gallery's cards, into the order you want,
  by pointer or keyboard; other people see it too.
- **Import.** Settings, Your data, imports a Markdown folder or zip, a Notion export (pages and
  their nesting, databases with typed properties and relations, row pages, links) or a Word
  document (headings, lists, tables, images, links), into a local or a synced workspace. It runs
  on your device, under a new page of its own, at most 2,000 pages and 500 MB; it ends with a
  report of what was made and what was left out, and one that fails or is stopped leaves nothing
  behind.
- **Email for mentions and replies.** When someone mentions you or replies to you and you have not
  read it within 15 minutes, you get one email, in your language, that opens the block. Choose a
  daily summary or no email in Settings; every email turns email off in one click.
- **One set of controls.** The slash and "@" menus, the formatting toolbar, the block handle,
  the sidebar's page tree, the breadcrumb, the icon picker, avatars, the comment box, the search
  palette and the database's menus, pickers, cell editors, board and calendar now come from Cash
  Gear's shared UI library, so they look and behave alike across Cash Gear's apps, in Arabic and
  English, light and dark. A board's columns move by keyboard as well as by pointer, and the tree
  takes Alt+Shift with the arrow keys to move a page.
- **Clearer notices.** A change the server refuses for access now says what was refused (a new
  section, a cover you cannot read, a move) and that it was undone.
- **Fixed.** A file attached on one device read "This file is not on this device" on the others
  and could not be opened there, since 0.2.0; it now shows its name and opens. The sync status no
  longer says "Signed out" for a moment as the app starts.
- **Faster server.** Each key typed costs the server about 40 % of the processor time it did in
  0.7.0, and reaches the others on the page sooner.
- **For whoever runs the server.** The update adds the mail settings and mail queue tables. Mail
  for mentions uses the SMTP account already set (`Smtp__From`), at most `Mail__DailyCap` (1,500)
  a day, with links built from `Api__PublicUrl` and `Web__AppUrl`; the worker now shares the
  API's Data Protection key ring. `install.ps1` already gives both processes these settings
  (`docs/OPERATIONS.md`).

## [0.7.0] - 2026-11-15

Change Cash Gear ERP vendors from a page after reviewing every change, add charts and boards over
your databases, and, when a workspace turns it on, ask AI for drafts you accept or discard.

- **Editing ERP data.** In an ERP block on Vendors, someone whose Cash Gear ERP account may edit
  vendors chooses "Edit data" and changes the name, group, mobile, payment method, address or tax
  file (and, with the advanced privilege, the currency and whether it is blocked). Changed cells
  are marked; nothing is written until "Review changes" shows every field's old and new value with
  any problem the ERP finds, and "Commit" sends them. If someone changed a vendor in the ERP
  meanwhile, both values are shown side by side and nothing is overwritten until you choose.
  Leaving the page with changes not committed asks first. Cash Gear ERP's own audit names the page
  each change came from, and Workspace's audit records each attempt without its values. The ERP
  decides who may change what, as always.
- **Charts and boards.** "/Chart" draws a bar, line or pie chart, or a single number, from a
  database view: rows counted, summed or averaged by a property. "/Kanban board" shows a view as a
  board grouped by a select or status property; moving a card changes that row. Both show only
  what you may see in the database.
- **AI, when a workspace turns it on.** Off until an owner or admin turns it on in Settings and
  enters the workspace's own Anthropic API key, which is kept encrypted on the server and never
  shown again; they also choose the model (Claude Opus 5.5 by default) and see this month's use.
  Then the AI panel beside a page rewrites a selection, summarises the page, lists its action
  items, drafts a new page or a new database, and answers questions from the pages you can read,
  with links to them. Every answer is a proposal: it enters the page only when you accept it, as
  one change Undo takes back. In an ERP block, "Prepare changes with AI" fills in changes for you
  to review; AI can never commit them. Only what each action needs is sent, and only from pages
  you can read.
- **Fixed.** A duplicated block (Ctrl+D), a pasted one, or any block made without an id could not
  be undone.
- **Versions.** Pages with a chart or a board move to document version 6, which 0.6.0 opens
  read-only.
- **For whoever runs the server.** The update adds the AI settings and usage tables; the API needs
  outbound HTTPS to `api.anthropic.com` once a workspace turns AI on (`docs/OPERATIONS.md`).
  Editing ERP data needs the ERP's Workspace commit (Track E6) deployed with its database script.

## [0.6.0] - 2026-11-15

Work on a page together: see each other's typing and cursors as it happens, comment on what you
read, and mention people.

- **Live editing.** Everyone on a page sees the others' typing as they type, in the browser and
  in the desktop app, and all end with the same text. If the live connection is blocked or lost,
  editing goes on and syncs as before; only the sync status shows it.
- **Who is here.** The people on a page are shown in its top bar, and beside the pages they have
  open in the sidebar, only on pages you can see. Their cursors and selections show in the page
  with their name and colour.
- **The sidebar keeps up.** Pages that others add, rename, move or share appear within a second
  while you are connected.
- **Comments.** Select text and press Ctrl+Alt+M (⌘⌥M on a Mac), or choose "Comment", to start a
  thread; Ctrl+Alt+Shift+M (⌘⌥⇧M) opens the comments panel. Reply, edit or delete your own, and resolve and
  reopen threads. A comment stays with its block when the block moves and when the text around it
  changes, and a comment whose block was removed says so. Comments need a connection in 0.6.0.
- **Mentions and the inbox.** "@" offers people as well as pages and dates. Someone mentioned in a
  page or a comment, or replied to, finds it in their inbox, which opens the page at that block.
  Nobody is told about a page they cannot read.
- **Access.** Someone whose access to a page is taken away, or who is removed from the workspace,
  stops receiving its changes at once.
- **Fixed.** If the app closed suddenly (a crash, a power cut) just after typing, a few
  characters could stay on the device without ever reaching the server; text typed after them was
  then refused by the server and gone on the next start. Every change is now on its way to the
  server before the device tidies its saved history.
- **Versions.** Pages edited in 0.6.0 move to document version 5, which 0.5.0 opens read-only.
- **For whoever runs the server.** The API's IIS site needs the WebSocket Protocol feature, which
  `install.ps1` turns on; the update adds the comment, notification and hub ticket tables
  (`docs/OPERATIONS.md`).

## [0.5.0] - 2026-11-14

Cash Gear Sheet workbooks in your pages, and read-only Cash Gear ERP data, each person seeing what
the ERP lets them see.

- **Workbooks.** `/workbook` in a page makes a new workbook or picks one from the workspace. The
  block shows a picture of the workbook with the date it was taken, then the live sheet, drawn by
  Cash Gear Sheet in a sealed frame; pick a sheet, a range or a chart, and set its height.
  "Refresh" shows the newest version; "Open in Cash Gear Sheet" opens it there to edit, and what
  you save shows in the page.
- **A workbook's own access.** A workbook belongs to the workspace, not to the page: owners and
  admins manage it, members edit it, guests see it only when named. Someone who can read the page
  but not the workbook sees "You don't have access to this workbook", and so does a page shared by
  link. "Workbooks" in the sidebar lists them: rename, trash and restore, and who may open each.
- **Offline.** The block keeps the last picture it showed on this device, with its date, so a
  page with workbooks still reads offline.
- **Between workbooks and databases.** "Import this range into a database" makes rows from a
  workbook's range, in a new database or an existing one; "Export to a workbook" on a database
  view makes a new workbook of its rows, ready to open in Cash Gear Sheet.
- **Cash Gear ERP.** A workspace owner links the workspace to an ERP company from the ERP
  ("Link Cash Gear Workspace"). `/erp` in a page shows Vendors, Customers or Items on hand, with
  the fields, filter, sorts and page size you choose, paged, with the time it was loaded and
  "Refresh". Each reader connects with their own ERP sign-in, so two people may rightly see
  different rows, and someone without the ERP's permission is told so and sees none.
- **Nothing of the ERP is kept.** ERP records are never saved in the page, on your device, in
  search or in history; they are gone when the page closes. Offline, the block says ERP data needs
  a connection.
- **Versions.** Pages edited in 0.5.0 move to document version 4, which 0.4.0 opens read-only with
  the new blocks as placeholders.

## [0.4.0] - 2026-11-14

Databases: tables of rows with typed properties, inside pages or as pages of their own, shown as
a table, a board, a list, a calendar or a gallery.

- **Databases.** "New database" wherever "New page" is, empty or from a template (Tasks,
  Projects, Reading list, Meeting notes, Contacts), and `/database` in a page for one inside it.
  `/linked view` shows a database that lives elsewhere. Every row is a page: open it for its
  properties above a page of its own.
- **Properties.** Text, number (with a format), date (with an end and a time), checkbox, select,
  multi-select, status, person, URL, email, phone and files; relations to another database, kept
  in step on both sides; rollups over them; formulas; and created and last edited time and by.
  Add, rename, reorder, hide and delete them; a deleted property can be restored with its values.
  Changing a property's type says what will happen to its values before it does.
- **Views.** A virtualised table that scrolls 50,000 rows smoothly; a board you drag cards across
  and within; a list; a month calendar you drag rows across; a gallery with covers. Each view has
  its own filter (conditions and groups), sorts, grouping and shown properties.
- **Formulas.** `prop("Name")`, arithmetic, comparisons, `if`, text, number and date functions,
  with the property names shown while you type and errors said plainly. The server computes the
  same results, so big databases filter and sort by them too.
- **Big databases.** Up to 5,000 rows, a database is kept on your device and works offline. Above
  that the server finds, sorts and pages the rows for you, and offline you see the rows this device
  has, and are told so.
- **Two people, one row.** Edits to different properties of a row both stand; for the same
  property the last to reach the server wins. An edit made offline before someone changed the
  property's type lands converted.
- **CSV.** Import a file into a database or as a new one, and export any view. Exported cells that
  a spreadsheet could run as formulas are made safe, and come back unchanged on import.
- **Dates in a page.** "@" offers Today, Tomorrow and a date picker; dates show in your language.
- **The rest.** Rows can be trashed and restored like pages; search finds rows; the workspace
  export and import keep databases, their views and rows; a shared link shows a note where a
  database is (databases are not shared by link yet).
- **Versions.** Pages edited in 0.4.0 move to document version 3, which 0.3.0 opens read-only; it
  never sees a database's rows. This device's store moves to version 4 (the desktop keeps a copy
  of the old file).
- **Fixed.** A page renamed elsewhere could stay stale while a visit to it waited to be sent.

## [0.3.0] - 2026-11-12

Offline: keep working with no network, on the desktop and in the browser, and everything syncs
when the network returns. A Mac app.

- **Offline.** The app starts with no network, still signed in, and says "Offline, N changes
  waiting" (the web app too, after one visit online). Pages you have opened before open as usual,
  edits are saved and new pages can be made; when the network returns everything is sent, with
  nothing to do. A page that is not on this device says so, and opens by itself once you are
  online.
- **Available offline.** "Make available offline" keeps a page, or a page and every page inside it,
  on this device and up to date in the background. Settings → Offline lists them and shows how
  much space this device uses.
- **Nothing you typed is lost.** If a page you edited offline was deleted for good, had an
  earlier version put back, or was taken out of your hands meanwhile, your copy becomes
  "Recovered: {title}" in your private section, and a notice links to it. The Recovered list,
  beside the Trash, shows them all. Every other conflict is told in a notice that says what
  happened and where your work is.
- **Moves while you type.** Yjs cannot move a block and keep someone's edit inside it; if that
  happens to you, you are told, and pointed to the page's history.
- **Table of contents.** A new block (`/toc`) that lists the page's headings, each a link.
- **View-only pages** now open read-only: nothing can be typed there to be refused later.
- **Export from the account.** Owners and admins can download the server's export of a workspace
  from Settings, beside the export from this device.
- **The Mac.** A universal app for Apple silicon and Intel Macs, macOS 13 or later, with the
  sign-in kept in the Mac's keychain and `cashgear-workspace://` links. Until the Apple signing
  credentials are set up, macOS warns when it is first opened.
- **Faster under load.** An edit now reaches other people within about 2 seconds with 200 people
  typing (it was up to a minute).
- **Keeping things.** Pages in the trash are deleted for good after 60 days. A device may be
  offline for up to 30 days and still sync; after that it signs in again first, and nothing on it
  is lost.
- **Versions.** Pages edited in 0.3.0 move to document version 2; 0.2.0 opens them read-only and
  asks for an update (a page 0.2.0 has never had, once it is reopened; anything typed there before
  that is refused, and the page stays as it was). This device's store moves to version 3 (the desktop keeps a copy of the old
  file); an older app refuses a newer store rather than touch it.
- **Fixed.** The Windows release talked to a development address instead of the server. A page
  title typed just before closing could be lost. Two devices repairing the same duplicated block
  at once multiplied it. A reopened page wrote as a new editing session's id. Error, warning and
  delete text was too faint in the dark theme.

## [0.2.0] - 2026-11-12

Accounts and the cloud: sign in, and a workspace is kept on the Cash Gear Workspace server and
shared across devices and people. Without signing in, everything works on this device as before.

- **Accounts.** Sign up with an email address (confirmed by a link), sign in, reset a forgotten
  password, and see and sign out the devices signed in to the account. The desktop app signs in
  through the system browser, which asks you to confirm it; its sign-in is kept in Windows
  Credential Manager.
- **Sync.** A workspace made while signed in lives on the server: pages, the tree and every
  document follow you to each device and update while you are online. Two people typing in the
  same page both keep their text. The sidebar shows whether everything is saved to the server.
- **Upload.** A workspace made on this device before signing in can be uploaded, keeping every
  page, its text and files, and the links between them. A workspace made while signed in goes to
  the account at once.
- **Members and invites.** Invite people to a workspace by email as admins, members or guests,
  change their roles and remove them. A guest sees only the pages shared with them.
- **Sharing.** Give chosen people (or the whole workspace) access to a page at a level, restrict
  it to them, or make a view link that anyone holding it can open read-only, and withdraw it.
- **Search across the account.** Ctrl+K also finds pages kept on the server, by title and text,
  in Arabic and English.
- **History on the server.** Earlier versions of a page are kept on the server too: name a
  version (it holds the page as it was when named), look at it, restore it as a new change that
  Ctrl+Z takes back, or, as an admin, replace a damaged page with it for everyone.
- **Files and bookmarks.** Images and files are kept on the server and shown on every device. A
  web bookmark shows the page's title, description and picture.
- **Deleting an account.** Delete an account and its data from the server, on the account's own
  page, after typing the password again. What is on your devices stays there.
- **Search.** Pressing Enter straight after typing opens the first result for what was typed.
  Before, an Enter that came before the search had answered acted on the earlier list.

## [0.1.0] - 2026-11-11

The first release: a local-first workspace of block pages, in a browser and as a Windows desktop
app, in English and Arabic. Everything is kept on this device; nothing is sent anywhere, and there
is no sign-in yet.

- **Workspaces and pages.** Create a workspace, then pages and pages inside pages in its sections.
  Drag pages in the sidebar to nest or reorder them, rename them in place (F2), mark favourites,
  and follow the breadcrumbs. Deleted pages go to the trash, from which they can be restored for
  60 days. A page can be made a template and copied with "New from template".
- **Block editing.** Text, three heading levels, bulleted, numbered and to-do lists, toggles,
  quotes, callouts, dividers, code with a language, tables, images, files, web bookmarks, child
  pages and page mentions. Type `/` for the block menu, in English or Arabic; Markdown shortcuts
  (`#`, `-`, `1.`, `[]`, `>`, three backticks) turn a line into a block as you type.
- **Formatting.** Bold, italic, underline, strikethrough, inline code, links and colours, from the
  keyboard or the toolbar over a selection.
- **Moving blocks.** Drag a block by its handle, or use Alt+Shift+Up and Down; Tab and Shift+Tab
  nest blocks. A block keeps its identity wherever it goes, so links to it keep working.
- **Saving.** Every change is saved on this device within a second of the last key, and kept
  through a crash or a closed window. Each page keeps earlier versions to look at and restore.
- **Search.** Ctrl+K finds pages by title and text, in Arabic and English alike: without
  tashkeel, with ه for ة, with either kind of digit. It also runs commands.
- **Export and import.** Export a page or a whole workspace as a zip of Markdown and JSON with its
  files; import such a zip as a new workspace.
- **Themes and languages.** Light, dark or the system's theme; English, or Arabic right to left
  throughout.
- **Phones and tablets.** On a narrow screen the sidebar is a drawer, and a toolbar above the
  keyboard inserts, formats and moves blocks.
- **Accessibility.** Every main screen passes Axe in both themes and both languages, works with
  the keyboard alone, and names its landmarks, tree and editor for screen readers.
- **Desktop.** A per-user Windows installer; `cashgear-workspace://` links open a page in
  the app; the app updates itself from GitHub releases when a newer version is published.
