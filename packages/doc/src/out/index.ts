// Phase 19: a page out of the workspace, as a Word file's parts (`writeDocx`) and as the print
// view's HTML (`printView`). `@cgw/doc/out`, loaded with the first export or print: none of it is
// in the initial JavaScript.
export { writeDocx, type DocxPart } from './docx';
export { printView, PRINT_FONTS, type PrintMode, type PrintView } from './print';
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
