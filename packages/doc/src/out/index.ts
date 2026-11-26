// Phase 19: a page out of the workspace, as a Word file's parts (`writeDocx`) and as the print
// view's HTML (`printView`). `@cgw/doc/out`, loaded with the first export or print: none of it is
// in the initial JavaScript. After 0.19.0 the shell's worker imports it, and reads each page's
// content from its stored log there (`readContent`).
export { writeDocx, type DocxPart } from './docx';
export { printView, PRINT_FONTS, type PrintMode, type PrintView } from './print';
export { readContent } from './read';
export {
  flatten,
  headings,
  pageDirection,
  textDirection,
  type Direction,
  type OutAsset,
  type OutBlock,
  type OutInput,
  type OutPage,
  type OutTable,
  type OutWords,
} from './model';
