# Changelog

Every release of Cash Gear Workspace, newest first. Versions follow semantic versioning, with one
version across the app, its crates and its packages. The release workflow takes each release's
notes from its section here.

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
