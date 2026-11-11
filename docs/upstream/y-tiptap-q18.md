# Draft for upstream: id-aware reconcile in `@tiptap/y-tiptap`

Not sent. This is the text for an issue and a pull request on `ueberdosis/tiptap` (the package
`@tiptap/y-tiptap`), for you to send if you choose (DECISIONS.md, 2026-11-11: Phase 1, Q18). The
change is carried here as `patches/@tiptap__y-tiptap@3.3.0.patch`, written by
`scripts/y-tiptap-patch.mjs`.

## Issue

**Title:** Moving or merging a block rewrites the blocks between its ends and loses a peer's typing

**Body:**

When a ProseMirror change moves a block (delete and insert in one transaction) or merges two
blocks, `updateYFragment` reconciles the children of the parent by position. A node of the same
type stands in for a different node, so the blocks between the move's ends are rewritten in Yjs
as deletions and insertions. A peer typing in one of those untouched blocks at the same moment
loses that typing once the updates merge.

The same reconcile also removes any attribute the local schema does not know when it writes a
node back, so an older client that edits a paragraph removes an attribute a newer client added.

Both show in a randomised test of two and three editors (moves, merges, splits, typing, random
delivery order): with stock 3.2.0 we measured 185 lost tokens over three runs of 10,000
operations in blocks nobody moved; with the change below, none.

**Proposal:** when nodes carry an `id` attribute, use it:

1. A node with an `id` never stands in for a node with a different `id` (`matchNodeName`).
2. Children with equal ids anchor the diff (`findMappedChildAnchors`), and one anchor is enough.
3. An anchored child whose mapped node is unchanged is not rewritten.
4. When writing attributes back, only attributes the node type declares are removed.

Nodes without ids behave exactly as before.

## Pull request

**Title:** fix(y-tiptap): reconcile children by id and keep unknown attributes

**Body:** Implements the issue above. About 40 lines in `reconciliation/matchNodeName.ts`,
`findMappedChildAnchors`, the anchored-children loop and `updateYFragment`. Tests: a two-editor
case where editor A moves block 1 below block 3 while editor B types in block 2; before the
change B's typing is lost, after it both texts survive. A second case: an attribute unknown to
editor B's schema survives B's edit of that node.
