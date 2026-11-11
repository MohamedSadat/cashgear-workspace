# Changelog

Every release of Cash Gear Workspace, newest first. Versions follow semantic versioning, with one
version across the app, its crates and its packages. The release workflow takes each release's
notes from its section here.

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
