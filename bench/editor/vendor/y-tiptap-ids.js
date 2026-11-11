// A copy of @tiptap/y-tiptap 3.2.0 (dist/index.js) for spike S1 only, with an id-aware
// reconciliation: a node with an id never stands in for a node with another id, and children with
// equal ids anchor the diff; and an attribute this schema does not know is kept rather than
// removed when the node is written back. It never ships. Its licence follows.
/*
The MIT License (MIT)

Copyright (c) 2019 Kevin Jahns <kevin.jahns@protonmail.com>.
Copyright (c) 2025 Tiptap GmbH.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
// @ts-nocheck
/* eslint-disable */
import * as Y from "yjs";
import { AbstractType, ContentType, Item, Text, UndoManager, XmlElement, XmlFragment, XmlHook, XmlText } from "yjs";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { AllSelection, NodeSelection, Plugin, PluginKey, Selection, TextSelection } from "@tiptap/pm/state";
import * as PModel from "@tiptap/pm/model";
import { Fragment, Node, Slice } from "@tiptap/pm/model";
import * as error from "lib0/error";
import { ReplaceStep, replaceStep } from "@tiptap/pm/transform";
import * as eventloop from "lib0/eventloop";
import { timeout } from "lib0/eventloop";
import * as math from "lib0/math";
import { createMutex } from "lib0/mutex";
import * as environment from "lib0/environment";
import * as dom from "lib0/dom";
import * as set from "lib0/set";
import * as random from "lib0/random";
import * as map from "lib0/map";
import * as sha256 from "lib0/hash/sha256";
import * as buf from "lib0/buffer";
import * as object from "lib0/object";
import { simpleDiff } from "lib0/diff";
//#region src/lib/utils/positions/getYType.ts
function getYType(item) {
	if (!item) return null;
	if (!(item.content instanceof ContentType)) return null;
	const type = item.content.type;
	if (!(type instanceof XmlFragment || type instanceof Text || type instanceof XmlHook)) throw new Error("Expected a Yjs XML type");
	return type;
}
//#endregion
//#region src/lib/utils/positions/getYParent.ts
function getYParent(item) {
	if (item === null) return null;
	if (!(item.parent instanceof AbstractType)) throw new Error("Expected an integrated Yjs parent");
	const type = item.parent;
	if (!(type instanceof XmlFragment || type instanceof Text || type instanceof XmlHook)) throw new Error("Expected a Yjs XML type");
	return type;
}
//#endregion
//#region src/lib/utils/positions/createRelativePosition.ts
const createRelativePosition = (type, item) => {
	let typeid = null;
	let tname = null;
	if (type._item === null) tname = Y.findRootTypeKey(type);
	else typeid = Y.createID(type._item.id.client, type._item.id.clock);
	return new Y.RelativePosition(typeid, tname, item.id);
};
//#endregion
//#region src/lib/utils/positions/absolutePositionToRelativePosition.ts
/** Converts a ProseMirror position to a Yjs relative position. */
const absolutePositionToRelativePosition = (pos, type, mapping) => {
	if (pos === 0) return Y.createRelativePositionFromTypeIndex(type, 0, -1);
	let n = getYType(type._first);
	while (n !== null && type !== n) {
		if (n instanceof Y.XmlText) {
			if (n._length >= pos) return Y.createRelativePositionFromTypeIndex(n, pos, -1);
			else pos -= n._length;
			if (n._item !== null && n._item.next !== null) n = getYType(n._item.next);
			else {
				do {
					n = getYParent(n._item);
					pos--;
				} while (n !== type && n !== null && n._item !== null && n._item.next === null);
				if (n !== null && n !== type) n = n._item === null ? null : getYType(n._item.next);
			}
		} else {
			const mapped = mapping.get(n);
			const pNodeSize = mapped instanceof Node ? mapped.nodeSize : 0;
			if (n._first !== null && pos < pNodeSize) {
				n = getYType(n._first);
				pos--;
			} else {
				if (pos === 1 && n._length === 0 && pNodeSize > 1) return new Y.RelativePosition(n._item === null ? null : n._item.id, n._item === null ? Y.findRootTypeKey(n) : null, null);
				pos -= pNodeSize;
				if (n._item !== null && n._item.next !== null) n = getYType(n._item.next);
				else {
					var _n$_item;
					if (pos === 0) {
						n = n._item === null ? n : getYParent(n._item);
						if (n === null) throw error.unexpectedCase();
						return new Y.RelativePosition(n._item === null ? null : n._item.id, n._item === null ? Y.findRootTypeKey(n) : null, null);
					}
					do {
						n = getYParent(n._item);
						if (n === null) throw error.unexpectedCase();
						pos--;
					} while (n !== type && ((_n$_item = n._item) === null || _n$_item === void 0 ? void 0 : _n$_item.next) === null);
					if (n !== type) {
						var _n$_item2;
						n = getYType((_n$_item2 = n._item) === null || _n$_item2 === void 0 ? void 0 : _n$_item2.next);
					}
				}
			}
		}
		if (n === null) throw error.unexpectedCase();
		if (pos === 0 && n.constructor !== Y.XmlText && n !== type) {
			const item = n._item;
			const parent = getYParent(item);
			if (item === null || parent === null) throw error.unexpectedCase();
			return createRelativePosition(parent, item);
		}
	}
	return Y.createRelativePositionFromTypeIndex(type, type._length, -1);
};
//#endregion
//#region src/lib/utils/positions/isStructuralTransaction.ts
/** Reports whether a transaction changes the document structure. */
const isStructuralTransaction = (tr, oldDoc) => {
	if (!tr.docChanged) return false;
	if (tr.doc.childCount !== oldDoc.childCount) return true;
	for (const step of tr.steps) if (step instanceof ReplaceStep) {
		if (step.from === 0 && step.to === oldDoc.content.size) return true;
		if (step.slice.content.size > 0) {
			let hasBlock = false;
			step.slice.content.forEach((node) => {
				if (node.isBlock) hasBlock = true;
			});
			if (hasBlock) return true;
		} else if (step.to > step.from) {
			const $from = oldDoc.resolve(step.from);
			const $to = oldDoc.resolve(step.to);
			if ($from.depth === 0 && $to.depth === 0 && $from.index() !== $to.index()) return true;
		}
	}
	return false;
};
//#endregion
//#region src/lib/utils/positions/getYTypeSize.ts
function getYTypeSize(type, mapping) {
	if (type instanceof XmlText) return type._length;
	const node = mapping.get(type);
	return node instanceof Node ? node.nodeSize : null;
}
//#endregion
//#region src/lib/utils/positions/getParentOffset.ts
function getParentOffset(parent, type, mapping) {
	let offset = 0;
	let item = parent._first;
	while (item !== null) {
		const child = getYType(item);
		if (child === type) break;
		const deleted = item.deleted;
		item = item.right;
		if (deleted) continue;
		if (child === null) return null;
		const size = getYTypeSize(child, mapping);
		if (size === null) return null;
		offset += size;
	}
	return offset;
}
//#endregion
//#region src/lib/utils/positions/getYContentOffset.ts
function getYContentOffset(type, index, mapping) {
	let offset = 0;
	let childIndex = 0;
	let item = type._first;
	while (childIndex < type._length && childIndex < index && item !== null) {
		const current = item;
		item = item.right;
		if (current.deleted) continue;
		const child = getYType(current);
		if (child === null) return null;
		const size = getYTypeSize(child, mapping);
		if (size === null) return null;
		childIndex++;
		offset += size;
	}
	return offset;
}
//#endregion
//#region src/lib/utils/positions/isMisresolvedTextPosition.ts
/** Detects a text position that resolved outside its original block. */
const isMisresolvedTextPosition = (y, relPos, absPos) => {
	var _decoded$type$_item;
	if (absPos === null) return false;
	const decoded = Y.createAbsolutePositionFromRelativePosition(relPos, y);
	return decoded !== null && decoded.type instanceof Y.XmlText && relPos.item !== null && ((_decoded$type$_item = decoded.type._item) === null || _decoded$type$_item === void 0 ? void 0 : _decoded$type$_item.deleted) === true;
};
//#endregion
//#region src/lib/utils/positions/relativePositionToAbsolutePosition.ts
/** Resolves a Yjs relative position, returning null when it cannot be mapped. */
const relativePositionToAbsolutePosition = (y, documentType, relPos, mapping) => {
	var _type$_item;
	const decodedPos = Y.createAbsolutePositionFromRelativePosition(relPos, y);
	if (decodedPos === null || decodedPos.type !== documentType && !Y.isParentOf(documentType, decodedPos.type._item)) return null;
	let type = decodedPos.type;
	let pos = 0;
	if (type.constructor === Y.XmlText) pos = decodedPos.index;
	else if (!((_type$_item = type._item) === null || _type$_item === void 0 ? void 0 : _type$_item.deleted)) {
		const offset = getYContentOffset(type, decodedPos.index, mapping);
		if (offset === null) return null;
		pos = offset + 1;
	}
	while (type !== documentType && type._item !== null) {
		var _parent$_item;
		const parent = getYParent(type._item);
		if (parent === null) return null;
		if ((_parent$_item = parent._item) === null || _parent$_item === void 0 ? void 0 : _parent$_item.deleted) {
			type = parent;
			continue;
		}
		const offset = getParentOffset(parent, type, mapping);
		if (offset === null) return null;
		pos += offset + 1;
		type = parent;
	}
	const absPos = pos - 1;
	if (isMisresolvedTextPosition(y, relPos, absPos)) return null;
	return absPos;
};
//#endregion
//#region src/lib/plugins/keys.ts
const ySyncPluginKey = new PluginKey("y-sync");
const yUndoPluginKey = new PluginKey("y-undo");
const yCursorPluginKey = new PluginKey("yjs-cursor");
//#endregion
//#region src/lib/plugins/setMeta.ts
let viewsToUpdate = null;
function takePendingMetas() {
	const pending = viewsToUpdate;
	viewsToUpdate = null;
	const entries = [];
	pending === null || pending === void 0 || pending.forEach((metas, view) => {
		metas.forEach((value, key) => entries.push({
			view,
			key,
			value
		}));
	});
	return entries;
}
function updateMetas(entries = takePendingMetas(), isRetry = false) {
	let isFirst = true;
	while (entries.length > 0) {
		const { view, key, value } = entries[0];
		try {
			const syncState = ySyncPluginKey.getState(view.state);
			if (syncState && syncState.binding.prosemirrorView !== null) view.dispatch(view.state.tr.setMeta(key, value));
		} catch (error) {
			if (!(error instanceof RangeError)) throw error;
			if (isRetry && isFirst) entries.shift();
			if (entries.length > 0) timeout(0, () => updateMetas(entries, true));
			return;
		}
		isFirst = false;
		entries.shift();
	}
}
/** Queues plugin metadata and batches repeated updates for the same key. */
function setMeta(view, key, value) {
	if (viewsToUpdate === null) {
		viewsToUpdate = /* @__PURE__ */ new Map();
		timeout(0, updateMetas);
	}
	let metas = viewsToUpdate.get(view);
	if (!metas) {
		metas = /* @__PURE__ */ new Map();
		viewsToUpdate.set(view, metas);
	}
	metas.set(key, value);
}
//#endregion
//#region src/lib/plugins/yCursorPlugin.ts
const defaultAwarenessStateFilter = (currentClientId, userClientId, _user) => currentClientId !== userClientId;
/** Creates the default remote cursor element from awareness user details. */
const defaultCursorBuilder = (user) => {
	const cursor = document.createElement("span");
	cursor.classList.add("ProseMirror-yjs-cursor");
	cursor.setAttribute("style", `border-color: ${user.color}`);
	const userDiv = document.createElement("div");
	userDiv.setAttribute("style", `background-color: ${user.color}`);
	userDiv.insertBefore(document.createTextNode(user.name), null);
	const nonbreakingSpace1 = document.createTextNode("⁠");
	const nonbreakingSpace2 = document.createTextNode("⁠");
	cursor.insertBefore(nonbreakingSpace1, null);
	cursor.insertBefore(userDiv, null);
	cursor.insertBefore(nonbreakingSpace2, null);
	return cursor;
};
/** Creates the default decoration attributes for a remote selection. */
const defaultSelectionBuilder = (user) => {
	return {
		style: `background-color: ${user.color}70`,
		class: "ProseMirror-yjs-selection"
	};
};
const getMappableSyncState = (state) => {
	const ystate = ySyncPluginKey.getState(state);
	return (ystate === null || ystate === void 0 ? void 0 : ystate.binding) && ystate.binding.invalidContentError === null ? ystate : null;
};
const rxValidColor = /^#[0-9a-fA-F]{6}$/;
const hasCursorUser = (user) => typeof user.name === "string" && typeof user.color === "string";
const createDecorations = (state, awareness, awarenessFilter, createCursor, createSelection) => {
	const ystate = getMappableSyncState(state);
	if (ystate == null || ystate.doc == null) return DecorationSet.create(state.doc, []);
	const y = ystate.doc;
	const decorations = [];
	if (ystate.snapshot != null || ystate.prevSnapshot != null || ystate.binding.mapping.size === 0) return DecorationSet.create(state.doc, []);
	awareness.getStates().forEach((aw, clientId) => {
		if (!awarenessFilter(y.clientID, clientId, aw)) return;
		if (aw && aw.cursor != null) {
			const user = { ...aw.user };
			if (user.color == null) user.color = "#ffa500";
			else if (!rxValidColor.test(user.color)) console.warn("A user uses an unsupported color format", user);
			if (user.name == null) user.name = `User: ${clientId}`;
			if (!hasCursorUser(user)) return;
			let anchor = relativePositionToAbsolutePosition(y, ystate.type, Y.createRelativePositionFromJSON(aw.cursor.anchor), ystate.binding.mapping);
			let head = relativePositionToAbsolutePosition(y, ystate.type, Y.createRelativePositionFromJSON(aw.cursor.head), ystate.binding.mapping);
			if (anchor !== null && head !== null) {
				const maxsize = math.max(state.doc.content.size - 1, 0);
				anchor = math.min(anchor, maxsize);
				head = math.min(head, maxsize);
				decorations.push(Decoration.widget(head, () => createCursor(user, clientId), {
					key: clientId + "",
					side: 10
				}));
				const from = math.min(anchor, head);
				const to = math.max(anchor, head);
				decorations.push(Decoration.inline(from, to, createSelection(user, clientId), {
					inclusiveEnd: true,
					inclusiveStart: false
				}));
			}
		}
	});
	return DecorationSet.create(state.doc, decorations);
};
/** Renders remote cursors and publishes the local selection through awareness. */
const yCursorPlugin = (awareness, { awarenessStateFilter = defaultAwarenessStateFilter, cursorBuilder = defaultCursorBuilder, selectionBuilder = defaultSelectionBuilder, getSelection = (state) => state.selection } = {}, cursorStateField = "cursor") => new Plugin({
	key: yCursorPluginKey,
	state: {
		init(_, state) {
			return createDecorations(state, awareness, awarenessStateFilter, cursorBuilder, selectionBuilder);
		},
		apply(tr, prevState, oldState, newState) {
			const ystate = ySyncPluginKey.getState(newState);
			const yCursorState = tr.getMeta(yCursorPluginKey);
			const isRemoteChange = ystate && ystate.isChangeOrigin;
			if (tr.docChanged && !isRemoteChange && isStructuralTransaction(tr, oldState.doc)) return DecorationSet.empty;
			if (isRemoteChange || yCursorState && yCursorState.awarenessUpdated) return createDecorations(newState, awareness, awarenessStateFilter, cursorBuilder, selectionBuilder);
			if (tr.docChanged) return prevState.map(tr.mapping, tr.doc);
			return prevState;
		}
	},
	props: { decorations: (state) => {
		var _yCursorPluginKey$get;
		return (_yCursorPluginKey$get = yCursorPluginKey.getState(state)) !== null && _yCursorPluginKey$get !== void 0 ? _yCursorPluginKey$get : DecorationSet.empty;
	} },
	view: (view) => {
		const awarenessListener = () => {
			if (!view.isDestroyed) setMeta(view, yCursorPluginKey, { awarenessUpdated: true });
		};
		const clearPublishedCursor = () => {
			var _awareness$getLocalSt;
			if (((_awareness$getLocalSt = awareness.getLocalState()) === null || _awareness$getLocalSt === void 0 ? void 0 : _awareness$getLocalSt[cursorStateField]) == null) return;
			awareness.setLocalStateField(cursorStateField, null);
		};
		const updateCursorInfo = (editorView) => {
			const ystate = getMappableSyncState(editorView.state);
			if (!ystate) {
				clearPublishedCursor();
				return;
			}
			const current = awareness.getLocalState() || {};
			if (editorView.hasFocus()) {
				const selection = getSelection(editorView.state);
				const anchor = absolutePositionToRelativePosition(selection.anchor, ystate.type, ystate.binding.mapping);
				const head = absolutePositionToRelativePosition(selection.head, ystate.type, ystate.binding.mapping);
				if (current.cursor == null || !Y.compareRelativePositions(Y.createRelativePositionFromJSON(current.cursor.anchor), anchor) || !Y.compareRelativePositions(Y.createRelativePositionFromJSON(current.cursor.head), head)) awareness.setLocalStateField(cursorStateField, {
					anchor,
					head
				});
			} else if (current.cursor != null && relativePositionToAbsolutePosition(ystate.doc, ystate.type, Y.createRelativePositionFromJSON(current.cursor.anchor), ystate.binding.mapping) !== null) awareness.setLocalStateField(cursorStateField, null);
		};
		const onFocusChange = () => updateCursorInfo(view);
		awareness.on("change", awarenessListener);
		view.dom.addEventListener("focusin", onFocusChange);
		view.dom.addEventListener("focusout", onFocusChange);
		return {
			update: updateCursorInfo,
			destroy: () => {
				view.dom.removeEventListener("focusin", onFocusChange);
				view.dom.removeEventListener("focusout", onFocusChange);
				awareness.off("change", awarenessListener);
				awareness.setLocalStateField(cursorStateField, null);
			}
		};
	}
});
//#endregion
//#region src/lib/plugins/getSyncPluginState.ts
function getSyncPluginState(state) {
	const pluginState = ySyncPluginKey.getState(state);
	if (!pluginState) throw new Error("The editor requires ySyncPlugin");
	return pluginState;
}
//#endregion
//#region src/lib/utils/binding/isVisible.ts
/** Reports whether a Yjs item is visible in the current document or a snapshot. */
const isVisible = (item, snapshot) => {
	var _snapshot$sv$get;
	return snapshot === void 0 ? !item.deleted : snapshot.sv.has(item.id.client) && ((_snapshot$sv$get = snapshot.sv.get(item.id.client)) !== null && _snapshot$sv$get !== void 0 ? _snapshot$sv$get : 0) > item.id.clock && !Y.isDeleted(snapshot.ds, item.id);
};
//#endregion
//#region src/lib/utils/binding/getUserColor.ts
const getUserColor = (colorMapping, colors, user) => {
	if (!colorMapping.has(user)) {
		if (colorMapping.size < colors.length) {
			const usedColors = set.create();
			colorMapping.forEach((color) => usedColors.add(color));
			colors = colors.filter((color) => !usedColors.has(color));
		}
		colorMapping.set(user, random.oneOf(colors));
	}
	const color = colorMapping.get(user);
	if (!color) throw new Error("At least one snapshot color is required");
	return color;
};
//#endregion
//#region src/lib/utils/positions/attrsEqual.ts
const attrsEqual = (a, b) => {
	if (a === b) return true;
	const aKeys = Object.keys(a);
	return aKeys.length === Object.keys(b).length && aKeys.every((k) => a[k] === b[k]);
};
//#endregion
//#region src/lib/utils/positions/hasDistinctiveAttrs.ts
const hasDistinctiveAttrs = (node) => {
	const specAttrs = node.type.spec.attrs || {};
	return Object.keys(node.attrs).some((key) => {
		const spec = specAttrs[key];
		return spec == null || !Object.prototype.hasOwnProperty.call(spec, "default") || spec.default !== node.attrs[key];
	});
};
//#endregion
//#region src/lib/utils/positions/findAbsolutePositionAfterStructuralChange.ts
/** Recovers a position in a moved block, returning null when the match is ambiguous. */
const findAbsolutePositionAfterStructuralChange = (oldDoc, newDoc, absPos) => {
	let pos = 0;
	let targetIdx = 0;
	for (; targetIdx < oldDoc.childCount; targetIdx++) {
		const child = oldDoc.child(targetIdx);
		if (pos + child.nodeSize > absPos) break;
		pos += child.nodeSize;
	}
	if (targetIdx >= oldDoc.childCount) return null;
	const targetChild = oldDoc.child(targetIdx);
	const $oldPos = oldDoc.resolve(absPos);
	const place = (newBlockStart, newBlock) => {
		if ($oldPos.depth === 0) {
			const remapped = newBlockStart + (absPos - pos);
			const contentStart = newBlockStart + 1;
			const contentEnd = newBlockStart + newBlock.nodeSize - 1;
			return Math.max(contentStart, Math.min(remapped, contentEnd));
		}
		if ($oldPos.depth > 1) {
			const innerPosition = findAbsolutePositionAfterStructuralChange($oldPos.node(1), newBlock, $oldPos.pos - $oldPos.start(1));
			return innerPosition === null ? null : newBlockStart + 1 + innerPosition;
		}
		if (!newBlock.isTextblock) return null;
		return newBlockStart + 1 + Math.min($oldPos.parentOffset, newBlock.content.size);
	};
	const findByPredicate = (pred, requireUnique = false) => {
		let occurrence = 0;
		for (let i = 0; i <= targetIdx; i++) if (pred(oldDoc.child(i))) occurrence++;
		let matchCount = 0;
		let matchStart = -1;
		let matchBlock = null;
		let newPos = 0;
		for (let i = 0; i < newDoc.childCount; i++) {
			const child = newDoc.child(i);
			if (pred(child)) {
				matchCount++;
				if (matchCount === occurrence) {
					matchStart = newPos;
					matchBlock = child;
				}
			}
			newPos += child.nodeSize;
		}
		if (matchBlock === null || requireUnique && (occurrence !== 1 || matchCount !== 1)) return null;
		return place(matchStart, matchBlock);
	};
	const sameTypeAndAttrs = (child) => child.type === targetChild.type && attrsEqual(child.attrs, targetChild.attrs);
	const oldText = targetChild.textContent;
	const byAll = findByPredicate((child) => sameTypeAndAttrs(child) && child.textContent === oldText);
	if (byAll !== null) return byAll;
	const byText = findByPredicate((child) => child.type === targetChild.type && child.textContent === oldText);
	if (byText !== null) return byText;
	if (!targetChild.isTextblock || hasDistinctiveAttrs(targetChild)) {
		const byAttrs = findByPredicate(sameTypeAndAttrs, true);
		if (byAttrs !== null) return byAttrs;
	}
	return findByPredicate((child) => sameTypeAndAttrs(child) && oldText !== "" && child.textContent !== "" && (oldText.startsWith(child.textContent) || child.textContent.startsWith(oldText)), true);
};
//#endregion
//#region src/lib/utils/positions/isMisresolvedAfterStructuralChange.ts
/** Detects a position that moved into a different block. */
const isMisresolvedAfterStructuralChange = (oldDoc, newDoc, oldAbs, resolvedAbs) => {
	if (resolvedAbs === null) return false;
	const $old = oldDoc.resolve(oldAbs);
	const $new = newDoc.resolve(resolvedAbs);
	if (!$old.parent.isTextblock) return false;
	if (!$new.parent.isTextblock) return true;
	if ($old.parent.textContent !== $new.parent.textContent) return true;
	if ($old.parentOffset !== 0 && $new.parentOffset === 0) return true;
	const bothAtStart = $old.parentOffset === 0 && $new.parentOffset === 0;
	const suspicious = $old.parentOffset !== $new.parentOffset || $old.parent.type !== $new.parent.type || !attrsEqual($old.parent.attrs, $new.parent.attrs);
	if (bothAtStart || suspicious) {
		const expected = findAbsolutePositionAfterStructuralChange(oldDoc, newDoc, oldAbs);
		return expected !== null && expected !== resolvedAbs;
	}
	return false;
};
//#endregion
//#region src/lib/utils/positions/restoreRelativeSelection.ts
const recoverSelectionEndpoint = (newDoc, oldDoc, oldAbs, resolved) => {
	if (oldAbs == null || oldAbs < 0 || oldAbs > oldDoc.content.size) return resolved;
	if (!(resolved === null || oldAbs > 1 && resolved <= 1 || isMisresolvedAfterStructuralChange(oldDoc, newDoc, oldAbs, resolved))) return resolved;
	const recovered = findAbsolutePositionAfterStructuralChange(oldDoc, newDoc, oldAbs);
	return recovered !== null ? recovered : resolved;
};
const restoreRelativeSelection = (tr, relSel, binding, oldDoc) => {
	if (relSel !== null && relSel.anchor !== null && relSel.head !== null) {
		if (relSel.type === "all") tr.setSelection(new AllSelection(tr.doc));
		else if (relSel.type === "node") {
			const anchor = relativePositionToAbsolutePosition(binding.doc, binding.type, relSel.anchor, binding.mapping);
			if (anchor !== null) tr.setSelection(createSafeNodeSelection(tr, anchor));
		} else if (relSel.type === "nodeRange") {
			const anchor = relativePositionToAbsolutePosition(binding.doc, binding.type, relSel.anchor, binding.mapping);
			const head = relativePositionToAbsolutePosition(binding.doc, binding.type, relSel.head, binding.mapping);
			const selection = createSafeNodeRangeSelection(tr, anchor, head, relSel.depth);
			if (selection !== null) tr.setSelection(selection);
		} else {
			let anchor = relativePositionToAbsolutePosition(binding.doc, binding.type, relSel.anchor, binding.mapping);
			let head = relativePositionToAbsolutePosition(binding.doc, binding.type, relSel.head, binding.mapping);
			if (oldDoc != null) {
				anchor = recoverSelectionEndpoint(tr.doc, oldDoc, relSel.absAnchor, anchor);
				head = recoverSelectionEndpoint(tr.doc, oldDoc, relSel.absHead, head);
			}
			if (anchor === null) anchor = head;
			if (head === null) head = anchor;
			if (anchor !== null && head !== null) tr.setSelection(TextSelection.between(tr.doc.resolve(anchor), tr.doc.resolve(head)));
		}
	}
};
const createSafeNodeSelection = (tr, pos) => {
	const $pos = tr.doc.resolve(pos);
	if ($pos.nodeAfter) return NodeSelection.create(tr.doc, pos);
	else return TextSelection.near($pos);
};
const createSafeNodeRangeSelection = (tr, anchor, head, depth) => {
	if (anchor === null || head === null) return null;
	const clampedAnchor = Math.min(Math.max(anchor, 0), tr.doc.content.size);
	const clampedHead = Math.min(Math.max(head, 0), tr.doc.content.size);
	try {
		const selection = Selection.fromJSON(tr.doc, {
			type: "nodeRange",
			anchor: clampedAnchor,
			head: clampedHead,
			depth
		});
		if (!selection.ranges.length) return TextSelection.near(tr.doc.resolve(clampedAnchor));
		return selection;
	} catch {
		return TextSelection.near(tr.doc.resolve(clampedAnchor));
	}
};
//#endregion
//#region src/lib/utils/positions/getRelativeSelection.ts
/** Captures the current selection as Yjs relative positions and absolute fallback positions. */
const getRelativeSelection = (pmbinding, state) => {
	const selection = state.selection;
	const json = selection.toJSON();
	const type = typeof json.type === "string" ? json.type : "text";
	return {
		type,
		depth: type === "nodeRange" && "depth" in selection && typeof selection.depth === "number" ? selection.depth : void 0,
		anchor: absolutePositionToRelativePosition(state.selection.anchor, pmbinding.type, pmbinding.mapping),
		head: absolutePositionToRelativePosition(state.selection.head, pmbinding.type, pmbinding.mapping),
		absAnchor: state.selection.anchor,
		absHead: state.selection.head
	};
};
//#endregion
//#region src/lib/utils/binding/projectedMappings.ts
const projectedMappings = /* @__PURE__ */ new WeakMap();
//#endregion
//#region src/lib/utils/binding/deleteMapping.ts
const deleteMapping = (mapping, type) => {
	var _projectedMappings$ge;
	if (!(type instanceof Y.XmlFragment || type instanceof Y.Text || type instanceof Y.XmlHook)) return;
	mapping.delete(type);
	(_projectedMappings$ge = projectedMappings.get(mapping)) === null || _projectedMappings$ge === void 0 || _projectedMappings$ge.delete(type);
};
//#endregion
//#region src/lib/utils/conversion/yattr2markname.ts
const hashedMarkNameRegex = /(.*)(--[a-zA-Z0-9+/=]{8})$/;
const yattr2markname = (attrName) => {
	var _hashedMarkNameRegex$, _hashedMarkNameRegex$2;
	return (_hashedMarkNameRegex$ = (_hashedMarkNameRegex$2 = hashedMarkNameRegex.exec(attrName)) === null || _hashedMarkNameRegex$2 === void 0 ? void 0 : _hashedMarkNameRegex$2[1]) !== null && _hashedMarkNameRegex$ !== void 0 ? _hashedMarkNameRegex$ : attrName;
};
//#endregion
//#region src/lib/utils/conversion/attributesToMarks.ts
const attributesToMarks = (attrs, schema) => {
	const marks = [];
	for (const markName in attrs) marks.push(schema.mark(yattr2markname(markName), attrs[markName]));
	return marks;
};
//#endregion
//#region src/lib/utils/conversion/deleteYType.ts
/** Deletes shared content that the editor schema cannot display. */
const deleteYType = (type) => {
	const doc = type.doc;
	const item = type._item;
	if (!doc || !item) throw error.unexpectedCase();
	doc.transact((transaction) => {
		item.delete(transaction);
	}, ySyncPluginKey);
};
//#endregion
//#region src/lib/utils/conversion/toError.ts
/** Wraps a thrown value in an `Error`. */
const toError = (value) => value instanceof Error ? value : new Error(String(value));
//#endregion
//#region src/lib/utils/conversion/createTextNodesFromYText.ts
const createTextNodesFromYText = (text, schema, meta, snapshot, prevSnapshot, computeYChange) => {
	const deltas = text.toDelta(snapshot, prevSnapshot, computeYChange);
	try {
		return deltas.map((delta) => schema.text(delta.insert, attributesToMarks(delta.attributes, schema)));
	} catch (error) {
		if (meta.reportInvalidContent) meta.reportInvalidContent(toError(error));
		else deleteYType(text);
		return null;
	}
};
//#endregion
//#region src/lib/utils/conversion/mergeNextYText.ts
/** Moves the content of a following text type into this one to avoid duplicated characters. */
const mergeNextYText = (text) => {
	var _text$_item;
	const content = (_text$_item = text._item) === null || _text$_item === void 0 || (_text$_item = _text$_item.right) === null || _text$_item === void 0 ? void 0 : _text$_item.content;
	const nextText = content instanceof Y.ContentType ? content.type : null;
	if (!(nextText instanceof Y.Text)) return;
	const nextItem = nextText._item;
	const nextDoc = nextText.doc;
	if (!nextItem || !nextDoc || nextItem.deleted || nextItem.id.client !== nextDoc.clientID) return;
	text.applyDelta([{ retain: text.length }, ...nextText.toDelta()]);
	nextDoc.transact((transaction) => {
		nextItem.delete(transaction);
	});
};
//#endregion
//#region src/lib/utils/conversion/createNodeFromYElement.ts
const getYChange = (el, snapshot, prevSnapshot, computeYChange) => {
	if (!el._item) return void 0;
	if (!isVisible(el._item, snapshot)) return computeYChange ? computeYChange("removed", el._item.id) : { type: "removed" };
	if (!isVisible(el._item, prevSnapshot)) return computeYChange ? computeYChange("added", el._item.id) : { type: "added" };
};
const setProjectedNode = (meta, el, node) => {
	meta.mapping.set(el, node);
	let projectedNodes = projectedMappings.get(meta.mapping);
	if (projectedNodes === void 0) {
		projectedNodes = /* @__PURE__ */ new WeakMap();
		projectedMappings.set(meta.mapping, projectedNodes);
	}
	projectedNodes.set(el, node);
};
const createNodeFromYElement = (el, schema, meta, snapshot, prevSnapshot, computeYChange) => {
	var _projectedMappings$ge;
	const cachedNode = meta.mapping.get(el);
	const cachedSingleNode = Array.isArray(cachedNode) ? void 0 : cachedNode;
	if (cachedSingleNode !== void 0 && ((_projectedMappings$ge = projectedMappings.get(meta.mapping)) === null || _projectedMappings$ge === void 0 ? void 0 : _projectedMappings$ge.get(el)) === cachedSingleNode) return cachedSingleNode;
	const children = [];
	let hasSkippedChild = false;
	const createChildren = (type) => {
		if (type instanceof Y.XmlElement) {
			const node = createNodeFromYElement(type, schema, meta, snapshot, prevSnapshot, computeYChange);
			if (node === null || meta.mapping.get(type) !== node) hasSkippedChild = true;
			if (node !== null) children.push(node);
			return;
		}
		if (!(type instanceof Y.XmlText)) return;
		if (meta.deferTextMerge) meta.deferTextMerge(type);
		else mergeNextYText(type);
		const textNodes = createTextNodesFromYText(type, schema, meta, snapshot, prevSnapshot, computeYChange);
		if (textNodes === null) hasSkippedChild = true;
		textNodes === null || textNodes === void 0 || textNodes.forEach((textNode) => children.push(textNode));
	};
	if (snapshot === void 0 || prevSnapshot === void 0) el.toArray().forEach(createChildren);
	else Y.typeListToArraySnapshot(el, new Y.Snapshot(prevSnapshot.ds, snapshot.sv)).forEach(createChildren);
	try {
		const attrs = el.getAttributes(snapshot);
		const ychange = snapshot ? getYChange(el, snapshot, prevSnapshot, computeYChange) : void 0;
		if (ychange !== void 0) attrs.ychange = ychange;
		let node = schema.node(el.nodeName, attrs, children);
		if (cachedSingleNode === null || cachedSingleNode === void 0 ? void 0 : cachedSingleNode.eq(node)) node = cachedSingleNode;
		if (hasSkippedChild && meta.reportInvalidContent) {
			deleteMapping(meta.mapping, el);
			return node;
		}
		setProjectedNode(meta, el, node);
		return node;
	} catch (error) {
		deleteMapping(meta.mapping, el);
		if (meta.reportInvalidContent) {
			meta.reportInvalidContent(toError(error));
			return null;
		}
		deleteYType(el);
		return null;
	}
};
//#endregion
//#region src/lib/utils/conversion/hashOfJSON.ts
const foldDigest = (digest) => {
	const hashBytes = 6;
	for (let i = hashBytes; i < digest.length; i++) digest[i % hashBytes] = digest[i % hashBytes] ^ digest[i];
	return digest.slice(0, hashBytes);
};
const hashOfJSON = (json) => buf.toBase64(foldDigest(sha256.digest(buf.encodeAny(json))));
//#endregion
//#region src/lib/utils/conversion/marksToAttributes.ts
const marksToAttributes = (marks, meta) => {
	const pattrs = {};
	marks.forEach((mark) => {
		if (mark.type.name !== "ychange") {
			const isOverlapping = map.setIfUndefined(meta.isOMark, mark.type, () => !mark.type.excludes(mark.type));
			pattrs[isOverlapping ? `${mark.type.name}--${hashOfJSON(mark.toJSON())}` : mark.type.name] = mark.attrs;
		}
	});
	return pattrs;
};
//#endregion
//#region src/lib/utils/conversion/createTypeFromTextNodes.ts
const createTypeFromTextNodes = (nodes, meta) => {
	const type = new Y.XmlText();
	const delta = nodes.map((node) => {
		var _node$text;
		return {
			insert: (_node$text = node.text) !== null && _node$text !== void 0 ? _node$text : "",
			attributes: marksToAttributes(node.marks, meta)
		};
	});
	type.applyDelta(delta);
	meta.mapping.set(type, nodes);
	return type;
};
//#endregion
//#region src/lib/utils/conversion/normalizePNodeContent.ts
const normalizePNodeContent = (pnode) => {
	const c = pnode.content.content;
	const res = [];
	for (let i = 0; i < c.length; i++) {
		const n = c[i];
		if (n.isText) {
			const textNodes = [];
			for (let tnode = c[i]; i < c.length && tnode.isText; tnode = c[++i]) textNodes.push(tnode);
			i--;
			res.push(textNodes);
		} else res.push(n);
	}
	return res;
};
//#endregion
//#region src/lib/utils/conversion/createTypeFromTextOrElementNode.ts
const createTypeFromTextOrElementNode = (node, meta) => node instanceof Array ? createTypeFromTextNodes(node, meta) : createTypeFromElementNode(node, meta);
const createTypeFromElementNode = (node, meta) => {
	const type = new Y.XmlElement(node.type.name);
	for (const key in node.attrs) {
		const val = node.attrs[key];
		if (val !== null && key !== "ychange") type.setAttribute(key, val);
	}
	type.insert(0, normalizePNodeContent(node).map((n) => createTypeFromTextOrElementNode(n, meta)));
	meta.mapping.set(type, node);
	return type;
};
//#endregion
//#region src/lib/utils/reconciliation/isObject.ts
const isObject = (val) => typeof val === "object" && val !== null;
//#endregion
//#region src/lib/utils/reconciliation/equalAttrs.ts
const equalAttrs = (pattrs, yattrs) => {
	const keys = Object.keys(pattrs).filter((key) => pattrs[key] !== null);
	let eq = keys.length === Object.keys(yattrs).filter((key) => yattrs[key] !== null).length;
	for (let i = 0; i < keys.length && eq; i++) {
		const key = keys[i];
		const l = pattrs[key];
		const r = yattrs[key];
		eq = key === "ychange" || l === r || isObject(l) && isObject(r) && equalAttrs(l, r);
	}
	return eq;
};
//#endregion
//#region src/lib/utils/reconciliation/equalYTextPText.ts
const equalYTextPText = (ytext, ptexts) => {
	const delta = ytext.toDelta();
	return delta.length === ptexts.length && delta.every((d, i) => {
		var _d$attributes;
		return d.insert === ptexts[i].text && object.keys(d.attributes || {}).length === ptexts[i].marks.length && Object.entries((_d$attributes = d.attributes) !== null && _d$attributes !== void 0 ? _d$attributes : {}).every(([yattrname, attr]) => {
			const markname = yattr2markname(yattrname);
			const pmark = ptexts[i].marks.find((mark) => mark.type.name === markname);
			if (!pmark) return false;
			return equalAttrs(attr, pmark.attrs);
		});
	});
};
//#endregion
//#region src/lib/utils/reconciliation/matchNodeName.ts
const sameBlockId = (yElement, pNode) => {
	const yId = yElement.getAttribute("id");
	const pId = pNode.attrs.id;
	return yId == null || pId == null || yId === pId;
};
const matchNodeName = (yElement, pNode) => !(pNode instanceof Array) && yElement.nodeName === pNode.type.name && sameBlockId(yElement, pNode);
//#endregion
//#region src/lib/utils/reconciliation/equalYTypePNode.ts
const equalYTypePNode = (ytype, pnode) => {
	if (ytype instanceof Y.XmlElement && !(pnode instanceof Array) && matchNodeName(ytype, pnode)) {
		const normalizedContent = normalizePNodeContent(pnode);
		return ytype._length === normalizedContent.length && equalAttrs(ytype.getAttributes(), pnode.attrs) && ytype.toArray().every((ychild, i) => equalYTypePNode(ychild, normalizedContent[i]));
	}
	return ytype instanceof Y.XmlText && pnode instanceof Array && equalYTextPText(ytype, pnode);
};
//#endregion
//#region src/lib/utils/reconciliation/mappedIdentity.ts
const mappedIdentity = (mapped, pcontent) => mapped === pcontent || mapped instanceof Array && pcontent instanceof Array && mapped.length === pcontent.length && mapped.every((a, i) => pcontent[i] === a);
//#endregion
//#region src/lib/utils/reconciliation/findMappedChildAnchors.ts
const findMappedChildAnchors = (yChildren, pChildren, meta) => {
	const pChildIndices = /* @__PURE__ */ new Map();
	pChildren.forEach((pChild, index) => {
		if (!pChildIndices.has(pChild)) pChildIndices.set(pChild, index);
	});
	const pIdIndices = /* @__PURE__ */ new Map();
	pChildren.forEach((pChild, index) => {
		const id = pChild instanceof Array ? null : pChild.attrs.id;
		if (id != null && !pIdIndices.has(id)) pIdIndices.set(id, index);
	});
	const candidates = [];
	yChildren.forEach((yChild, yIndex) => {
		const mapped = meta.mapping.get(yChild);
		let pIndex = mapped === void 0 ? void 0 : pChildIndices.get(mapped);
		if (pIndex !== void 0 && !mappedIdentity(mapped, pChildren[pIndex])) pIndex = void 0;
		if (pIndex === void 0 && yChild instanceof Y.XmlElement) {
			const id = yChild.getAttribute("id");
			if (id != null) pIndex = pIdIndices.get(id);
		}
		if (pIndex !== void 0) candidates.push({
			yIndex,
			pIndex,
			yChild
		});
	});
	if (candidates.length === 0) return [];
	const predecessors = [];
	const tails = [];
	for (let index = 0; index < candidates.length; index++) {
		let low = 0;
		let high = tails.length;
		while (low < high) {
			const middle = low + high >> 1;
			if (candidates[tails[middle]].pIndex < candidates[index].pIndex) low = middle + 1;
			else high = middle;
		}
		predecessors[index] = low > 0 ? tails[low - 1] : -1;
		tails[low] = index;
	}
	const anchors = [];
	for (let index = tails[tails.length - 1]; index !== -1; index = predecessors[index]) anchors.push(candidates[index]);
	return anchors.reverse();
};
//#endregion
//#region src/lib/utils/reconciliation/ytextTrans.ts
const ytextTrans = (ytext) => {
	let str = "";
	let n = ytext._start;
	const nAttrs = {};
	while (n !== null) {
		if (!n.deleted) {
			if (n.countable && n.content instanceof Y.ContentString) str += n.content.str;
			else if (n.content instanceof Y.ContentFormat) nAttrs[n.content.key] = null;
		}
		n = n.right;
	}
	return {
		str,
		nAttrs
	};
};
//#endregion
//#region src/lib/utils/reconciliation/updateYText.ts
const updateYText = (ytext, ptexts, meta) => {
	meta.mapping.set(ytext, ptexts);
	const { nAttrs, str } = ytextTrans(ytext);
	const content = ptexts.map((p) => {
		var _p$text;
		return {
			insert: (_p$text = p.text) !== null && _p$text !== void 0 ? _p$text : "",
			attributes: Object.assign({}, nAttrs, marksToAttributes(p.marks, meta))
		};
	});
	const { insert, remove, index } = simpleDiff(str, content.map((c) => c.insert).join(""));
	ytext.delete(index, remove);
	ytext.insert(index, insert);
	ytext.applyDelta(content.map((c) => ({
		retain: c.insert.length,
		attributes: c.attributes
	})));
};
//#endregion
//#region src/lib/utils/reconciliation/updateMatchingYChild.ts
const updateMatchingYChild = (y, yChild, pChild, meta, updateFragment) => {
	if (yChild instanceof Y.XmlText && pChild instanceof Array) {
		if (equalYTextPText(yChild, pChild)) meta.mapping.set(yChild, pChild);
		else updateYText(yChild, pChild, meta);
		return true;
	}
	if (yChild instanceof Y.XmlElement && !(pChild instanceof Array) && matchNodeName(yChild, pChild)) {
		if (equalYTypePNode(yChild, pChild)) meta.mapping.set(yChild, pChild);
		else updateFragment(y, yChild, pChild, meta);
		return true;
	}
	return false;
};
//#endregion
//#region src/lib/utils/reconciliation/deleteYChildren.ts
const deleteYChildren = (yDomFragment, index, length, meta) => {
	if (length > 0) {
		yDomFragment.slice(index, index + length).forEach((type) => deleteMapping(meta.mapping, type));
		yDomFragment.delete(index, length);
	}
};
//#endregion
//#region src/lib/utils/reconciliation/insertPChildren.ts
const insertPChildren = (yDomFragment, index, pChildren, start, end, meta) => {
	if (start < end) {
		const children = [];
		for (let childIndex = start; childIndex < end; childIndex++) children.push(createTypeFromTextOrElementNode(pChildren[childIndex], meta));
		yDomFragment.insert(index, children);
	}
};
//#endregion
//#region src/lib/utils/reconciliation/reconcileUnanchoredChildren.ts
const reconcileUnanchoredChildren = (y, yDomFragment, pChildren, yChildren, yStart, yEnd, pStart, pEnd, meta, updateFragment) => {
	const matchingChildren = math.min(yEnd - yStart, pEnd - pStart);
	for (let index = 0; index < matchingChildren; index++) {
		const yChild = yChildren[yStart + index];
		const pChild = pChildren[pStart + index];
		if (!updateMatchingYChild(y, yChild, pChild, meta, updateFragment)) {
			deleteYChildren(yDomFragment, pStart + index, 1, meta);
			insertPChildren(yDomFragment, pStart + index, pChildren, pStart + index, pStart + index + 1, meta);
		}
	}
	deleteYChildren(yDomFragment, pStart + matchingChildren, yEnd - yStart - matchingChildren, meta);
	insertPChildren(yDomFragment, pStart + matchingChildren, pChildren, pStart + matchingChildren, pEnd, meta);
};
//#endregion
//#region src/lib/utils/reconciliation/reconcileMappedChildren.ts
const reconcileMappedChildren = (y, yDomFragment, pChildren, yChildren, meta, updateFragment) => {
	const anchors = findMappedChildAnchors(yChildren, pChildren, meta);
	if (anchors.length < 1 || !anchors.some((anchor) => anchor.yIndex !== anchor.pIndex) || anchors.some((anchor) => {
		const pChild = pChildren[anchor.pIndex];
		return !(anchor.yChild instanceof Y.XmlText && pChild instanceof Array || anchor.yChild instanceof Y.XmlElement && !(pChild instanceof Array));
	})) return false;
	let yIndex = 0;
	let pIndex = 0;
	for (const anchor of anchors) {
		reconcileUnanchoredChildren(y, yDomFragment, pChildren, yChildren, yIndex, anchor.yIndex, pIndex, anchor.pIndex, meta, updateFragment);
		const pChild = pChildren[anchor.pIndex];
		if (!mappedIdentity(meta.mapping.get(anchor.yChild), pChild)) updateMatchingYChild(y, anchor.yChild, pChild, meta, updateFragment);
		yIndex = anchor.yIndex + 1;
		pIndex = anchor.pIndex + 1;
	}
	reconcileUnanchoredChildren(y, yDomFragment, pChildren, yChildren, yIndex, yChildren.length, pIndex, pChildren.length, meta, updateFragment);
	return true;
};
//#endregion
//#region src/lib/utils/reconciliation/computeChildEqualityFactor.ts
const computeChildEqualityFactor = (ytype, pnode, meta) => {
	const yChildren = ytype.toArray();
	const pChildren = normalizePNodeContent(pnode);
	const pChildCnt = pChildren.length;
	const yChildCnt = yChildren.length;
	const minCnt = math.min(yChildCnt, pChildCnt);
	let left = 0;
	let right = 0;
	let foundMappedChild = false;
	for (; left < minCnt; left++) {
		const leftY = yChildren[left];
		const leftP = pChildren[left];
		if (mappedIdentity(meta.mapping.get(leftY), leftP)) foundMappedChild = true;
		else if (!equalYTypePNode(leftY, leftP)) break;
	}
	for (; left + right < minCnt; right++) {
		const rightY = yChildren[yChildCnt - right - 1];
		const rightP = pChildren[pChildCnt - right - 1];
		if (mappedIdentity(meta.mapping.get(rightY), rightP)) foundMappedChild = true;
		else if (!equalYTypePNode(rightY, rightP)) break;
	}
	return {
		equalityFactor: left + right,
		foundMappedChild
	};
};
//#endregion
//#region src/lib/utils/reconciliation/updateYFragment.ts
/** Updates a Yjs XML fragment to match a ProseMirror node while preserving mapped children. */
const updateYFragment = (y, yDomFragment, pNode, meta) => {
	if (yDomFragment instanceof Y.XmlElement && yDomFragment.nodeName !== pNode.type.name) throw new Error("node name mismatch!");
	meta.mapping.set(yDomFragment, pNode);
	if (yDomFragment instanceof Y.XmlElement) {
		const yDomAttrs = yDomFragment.getAttributes();
		const pAttrs = pNode.attrs;
		for (const key in pAttrs) {
			if (pAttrs[key] === null) {
				yDomFragment.removeAttribute(key);
				continue;
			}
			if (yDomAttrs[key] !== pAttrs[key] && key !== "ychange") yDomFragment.setAttribute(key, pAttrs[key]);
		}
		for (const key in yDomAttrs) if (pAttrs[key] === void 0 && key in pNode.type.attrs) yDomFragment.removeAttribute(key); // an attribute this schema does not know is kept (S2)
	}
	const pChildren = normalizePNodeContent(pNode);
	const pChildCnt = pChildren.length;
	const yChildren = yDomFragment.toArray();
	const yChildCnt = yChildren.length;
	const minCnt = math.min(pChildCnt, yChildCnt);
	let reconciled = false;
	y.transact(() => {
		reconciled = reconcileMappedChildren(y, yDomFragment, pChildren, yChildren, meta, updateYFragment);
	}, ySyncPluginKey);
	if (reconciled) return;
	let left = 0;
	let right = 0;
	for (; left < minCnt; left++) {
		const leftY = yChildren[left];
		const leftP = pChildren[left];
		if (mappedIdentity(meta.mapping.get(leftY), leftP)) continue;
		if (!equalYTypePNode(leftY, leftP)) break;
		meta.mapping.set(leftY, leftP);
	}
	for (; right + left + 1 < minCnt; right++) {
		const rightY = yChildren[yChildCnt - right - 1];
		const rightP = pChildren[pChildCnt - right - 1];
		if (mappedIdentity(meta.mapping.get(rightY), rightP)) continue;
		if (!equalYTypePNode(rightY, rightP)) break;
		meta.mapping.set(rightY, rightP);
	}
	y.transact(() => {
		while (yChildCnt - left - right > 0 && pChildCnt - left - right > 0) {
			const leftY = yChildren[left];
			const leftP = pChildren[left];
			const rightY = yChildren[yChildCnt - right - 1];
			const rightP = pChildren[pChildCnt - right - 1];
			if (leftY instanceof Y.XmlText && leftP instanceof Array) {
				if (!equalYTextPText(leftY, leftP)) updateYText(leftY, leftP, meta);
				left += 1;
				continue;
			}
			let updateLeft = leftY instanceof Y.XmlElement && matchNodeName(leftY, leftP);
			let updateRight = rightY instanceof Y.XmlElement && matchNodeName(rightY, rightP);
			if (updateLeft && updateRight && leftY instanceof Y.XmlElement && rightY instanceof Y.XmlElement && !Array.isArray(leftP) && !Array.isArray(rightP)) {
				const equalityLeft = computeChildEqualityFactor(leftY, leftP, meta);
				const equalityRight = computeChildEqualityFactor(rightY, rightP, meta);
				if (equalityLeft.foundMappedChild && !equalityRight.foundMappedChild) updateRight = false;
				else if (!equalityLeft.foundMappedChild && equalityRight.foundMappedChild) updateLeft = false;
				else if (equalityLeft.equalityFactor < equalityRight.equalityFactor) updateLeft = false;
				else updateRight = false;
			}
			if (updateLeft && leftY instanceof Y.XmlElement && !Array.isArray(leftP)) {
				updateYFragment(y, leftY, leftP, meta);
				left += 1;
				continue;
			}
			if (updateRight && rightY instanceof Y.XmlElement && !Array.isArray(rightP)) {
				updateYFragment(y, rightY, rightP, meta);
				right += 1;
				continue;
			}
			deleteMapping(meta.mapping, yDomFragment.get(left));
			yDomFragment.delete(left, 1);
			yDomFragment.insert(left, [createTypeFromTextOrElementNode(leftP, meta)]);
			left += 1;
		}
		const yDelLen = yChildCnt - left - right;
		if (yChildCnt === 1 && pChildCnt === 0 && yChildren[0] instanceof Y.XmlText) {
			deleteMapping(meta.mapping, yChildren[0]);
			yChildren[0].delete(0, yChildren[0].length);
		} else if (yDelLen > 0) {
			yDomFragment.slice(left, left + yDelLen).forEach((type) => deleteMapping(meta.mapping, type));
			yDomFragment.delete(left, yDelLen);
		}
		if (left + right >= pChildCnt) return;
		const childrenToInsert = [];
		for (let index = left; index < pChildCnt - right; index++) childrenToInsert.push(createTypeFromTextOrElementNode(pChildren[index], meta));
		yDomFragment.insert(left, childrenToInsert);
	}, ySyncPluginKey);
};
//#endregion
//#region src/lib/utils/binding/replaceChangedChildren.ts
const replaceChangedChildren = (tr, content) => {
	var _step$apply$doc;
	const oldContent = tr.doc.content;
	let start = 0;
	let from = 0;
	while (start < oldContent.childCount && start < content.childCount && oldContent.child(start) === content.child(start)) {
		from += oldContent.child(start).nodeSize;
		start++;
	}
	let oldEnd = oldContent.childCount;
	let newEnd = content.childCount;
	let suffixSize = 0;
	while (oldEnd > start && newEnd > start && oldContent.child(oldEnd - 1) === content.child(newEnd - 1)) {
		suffixSize += oldContent.child(oldEnd - 1).nodeSize;
		oldEnd--;
		newEnd--;
	}
	if (start === oldEnd && start === newEnd) return tr;
	const slice = new Slice(content.cut(from, content.size - suffixSize), 0, 0);
	const step = replaceStep(tr.doc, from, oldContent.size - suffixSize, slice);
	if (step !== null && ((_step$apply$doc = step.apply(tr.doc).doc) === null || _step$apply$doc === void 0 ? void 0 : _step$apply$doc.content.eq(content))) return tr.step(step);
	return tr.replace(0, oldContent.size, new Slice(content, 0, 0));
};
//#endregion
//#region src/lib/utils/binding/ProsemirrorBinding.ts
/** Synchronizes one integrated Yjs XML fragment with a ProseMirror editor view. */
var ProsemirrorBinding = class {
	constructor(yXmlFragment, mapping = /* @__PURE__ */ new Map(), onInvalidContent) {
		this.prosemirrorView = null;
		this.mux = createMutex();
		this.isOMark = /* @__PURE__ */ new Map();
		this.beforeTransactionSelection = null;
		this._domSelectionInView = null;
		this._invalidContentError = null;
		this.projectionError = null;
		this.hasSharedContent = false;
		this.pendingTextMerges = [];
		this.type = yXmlFragment;
		this.mapping = mapping;
		this._observeFunction = this._typeChanged.bind(this);
		if (onInvalidContent) {
			this.onInvalidContent = onInvalidContent;
			this.reportInvalidContent = (error) => {
				var _this$projectionError;
				(_this$projectionError = this.projectionError) !== null && _this$projectionError !== void 0 || (this.projectionError = error);
			};
			this.deferTextMerge = (text) => {
				this.pendingTextMerges.push(text);
			};
		}
		if (yXmlFragment.doc === null) throw new Error("The Yjs fragment must belong to a document");
		this.doc = yXmlFragment.doc;
		this.beforeAllTransactions = () => {
			if (this._invalidContentError === null && this.beforeTransactionSelection === null && this.prosemirrorView != null) this.beforeTransactionSelection = getRelativeSelection(this, this.view.state);
		};
		this.afterAllTransactions = () => {
			this.beforeTransactionSelection = null;
		};
	}
	/**
	* Returns the schema error that pauses editing and shared writes.
	* Only set when the binding keeps invalid content.
	* @returns The error, or null when the shared content fits the editor schema.
	*/
	get invalidContentError() {
		return this._invalidContentError;
	}
	get view() {
		if (!this.prosemirrorView) throw new Error("The binding has no editor view");
		return this.prosemirrorView;
	}
	get _tr() {
		return this.view.state.tr.setMeta("addToHistory", false);
	}
	_isLocalCursorInView() {
		if (!this.view.hasFocus()) return false;
		if (environment.isBrowser && this._domSelectionInView === null) {
			eventloop.timeout(0, () => {
				this._domSelectionInView = null;
			});
			this._domSelectionInView = this._isDomSelectionInView();
		}
		return this._domSelectionInView;
	}
	_isDomSelectionInView() {
		const root = this.view.root;
		const selection = "getSelection" in root && typeof root.getSelection === "function" ? root.getSelection() : this.view.dom.ownerDocument.getSelection();
		if (selection == null || selection.anchorNode == null || selection.focusNode == null) return false;
		const range = this.view.dom.ownerDocument.createRange();
		range.setStart(selection.anchorNode, selection.anchorOffset);
		range.setEnd(selection.focusNode, selection.focusOffset);
		if (range.getClientRects().length === 0) {
			if (range.startContainer && range.collapsed) range.selectNodeContents(range.startContainer);
		}
		const bounding = range.getBoundingClientRect();
		const documentElement = dom.doc.documentElement;
		return bounding.bottom >= 0 && bounding.right >= 0 && bounding.left <= (window.innerWidth || documentElement.clientWidth || 0) && bounding.top <= (window.innerHeight || documentElement.clientHeight || 0);
	}
	renderSnapshot(snapshot, prevSnapshot) {
		if (!prevSnapshot) prevSnapshot = Y.createSnapshot(Y.createDeleteSet(), /* @__PURE__ */ new Map());
		this.view.dispatch(this._tr.setMeta(ySyncPluginKey, {
			snapshot,
			prevSnapshot
		}));
	}
	createDocumentContent() {
		this.projectionError = null;
		this.pendingTextMerges = [];
		const fragmentContent = this.type.toArray().map((type) => {
			if (!(type instanceof Y.XmlElement)) throw error.methodUnimplemented();
			return createNodeFromYElement(type, this.view.state.schema, this);
		}).filter((node) => node !== null);
		const content = PModel.Fragment.from(fragmentContent);
		const { topNodeType } = this.view.state.schema;
		this.hasSharedContent || (this.hasSharedContent = this.type.length > 0);
		const isPlaceholder = content.childCount === 0 && !this.hasSharedContent;
		if (this.reportInvalidContent && !isPlaceholder && !topNodeType.validContent(content)) this.reportInvalidContent(/* @__PURE__ */ new RangeError("Shared content does not fit the document schema"));
		if (this.projectionError === null) this.pendingTextMerges.forEach(mergeNextYText);
		return content;
	}
	/** Returns the projection error only when the content just stopped fitting the schema. */
	updateInvalidContentError() {
		const error = this.projectionError;
		const isNewError = error !== null && this._invalidContentError === null;
		this._invalidContentError = error;
		return isNewError ? error : null;
	}
	notifyInvalidContent(error) {
		var _this$onInvalidConten;
		if (error) (_this$onInvalidConten = this.onInvalidContent) === null || _this$onInvalidConten === void 0 || _this$onInvalidConten.call(this, error);
	}
	createDocumentTransaction() {
		const content = this.createDocumentContent();
		return this._tr.replace(0, this.view.state.doc.content.size, new PModel.Slice(content, 0, 0));
	}
	unrenderSnapshot() {
		this.mapping.clear();
		projectedMappings.delete(this.mapping);
		let newError = null;
		this.mux(() => {
			const tr = this.createDocumentTransaction();
			newError = this.updateInvalidContentError();
			tr.setMeta(ySyncPluginKey, {
				snapshot: null,
				prevSnapshot: null
			});
			this.view.dispatch(tr);
		});
		this.notifyInvalidContent(newError);
	}
	_forceRerender() {
		this.mapping.clear();
		projectedMappings.delete(this.mapping);
		let newError = null;
		this.mux(() => {
			const sel = this.beforeTransactionSelection !== null ? null : this.view.state.selection;
			const tr = this.createDocumentTransaction();
			newError = this.updateInvalidContentError();
			if (sel) {
				const clampedAnchor = math.min(math.max(sel.anchor, 0), tr.doc.content.size);
				const clampedHead = math.min(math.max(sel.head, 0), tr.doc.content.size);
				tr.setSelection(TextSelection.create(tr.doc, clampedAnchor, clampedHead));
			}
			this.view.dispatch(tr.setMeta(ySyncPluginKey, {
				isChangeOrigin: true,
				binding: this
			}));
		});
		this.notifyInvalidContent(newError);
	}
	_renderSnapshot(snapshot, prevSnapshot, pluginState) {
		var _prevSnapshot;
		let historyDoc = this.doc;
		let historyType = this.type;
		if (!snapshot) snapshot = Y.snapshot(this.doc);
		if (snapshot instanceof Uint8Array || prevSnapshot instanceof Uint8Array) {
			if (!(snapshot instanceof Uint8Array) || !(prevSnapshot instanceof Uint8Array)) throw error.unexpectedCase();
			historyDoc = new Y.Doc({ gc: false });
			Y.applyUpdateV2(historyDoc, prevSnapshot);
			prevSnapshot = Y.snapshot(historyDoc);
			Y.applyUpdateV2(historyDoc, snapshot);
			snapshot = Y.snapshot(historyDoc);
			if (historyType._item === null) {
				const rootKey = Array.from(this.doc.share.keys()).find((key) => Object.is(this.doc.share.get(key), historyType));
				historyType = historyDoc.getXmlFragment(rootKey);
			} else {
				var _historyDoc$store$cli;
				const historyStructs = (_historyDoc$store$cli = historyDoc.store.clients.get(historyType._item.id.client)) !== null && _historyDoc$store$cli !== void 0 ? _historyDoc$store$cli : [];
				const item = historyStructs[Y.findIndexSS(historyStructs, historyType._item.id.clock)];
				if (!(item instanceof Y.Item && item.content instanceof Y.ContentType && item.content.type instanceof Y.XmlFragment)) throw error.unexpectedCase();
				historyType = item.content.type;
			}
		}
		const currentSnapshot = snapshot;
		const previousSnapshot = (_prevSnapshot = prevSnapshot) !== null && _prevSnapshot !== void 0 ? _prevSnapshot : Y.emptySnapshot;
		this.mapping.clear();
		projectedMappings.delete(this.mapping);
		this.mux(() => {
			historyDoc.transact((transaction) => {
				const pud = pluginState.permanentUserData;
				if (pud) pud.dss.forEach((ds) => {
					Y.iterateDeletedStructs(transaction, ds, (_item) => {});
				});
				const computeYChange = (type, id) => {
					const user = pud ? type === "added" ? pud.getUserByClientId(id.client) : pud.getUserByDeletedId(id) : null;
					return {
						user,
						type,
						color: getUserColor(pluginState.colorMapping, pluginState.colors, user)
					};
				};
				const fragmentContent = Y.typeListToArraySnapshot(historyType, new Y.Snapshot(previousSnapshot.ds, currentSnapshot.sv)).map((t) => {
					if (!(t instanceof Y.XmlElement) || !t._item) return null;
					if (!t._item.deleted || isVisible(t._item, currentSnapshot) || isVisible(t._item, previousSnapshot)) return createNodeFromYElement(t, this.view.state.schema, {
						mapping: /* @__PURE__ */ new Map(),
						isOMark: /* @__PURE__ */ new Map(),
						reportInvalidContent: this.reportInvalidContent ? () => {} : void 0,
						deferTextMerge: this.reportInvalidContent ? () => {} : void 0
					}, currentSnapshot, previousSnapshot, computeYChange);
					else return null;
				}).filter((n) => n !== null);
				const tr = this._tr.replace(0, this.view.state.doc.content.size, new PModel.Slice(PModel.Fragment.from(fragmentContent), 0, 0));
				this.view.dispatch(tr.setMeta(ySyncPluginKey, { isChangeOrigin: true }));
			}, ySyncPluginKey);
		});
	}
	_typeChanged(events, transaction) {
		var _transaction$origin$c;
		if (this.prosemirrorView == null) return;
		const syncState = getSyncPluginState(this.view.state);
		if (events.length === 0 || syncState.snapshot != null || syncState.prevSnapshot != null) {
			this.renderSnapshot(syncState.snapshot, syncState.prevSnapshot);
			return;
		}
		const isUndoRedoOperation = transaction.origin instanceof Y.UndoManager;
		const undoSelection = isUndoRedoOperation ? (_transaction$origin$c = transaction.origin.currStackItem) === null || _transaction$origin$c === void 0 ? void 0 : _transaction$origin$c.meta.get(this) : void 0;
		const selection = undoSelection || this.beforeTransactionSelection;
		const oldDoc = undoSelection ? void 0 : this.view.state.doc;
		let newError = null;
		this.mux(() => {
			const delType = (_, type) => deleteMapping(this.mapping, type);
			Y.iterateDeletedStructs(transaction, transaction.deleteSet, (struct) => {
				if (struct instanceof Y.Item && struct.content instanceof Y.ContentType) deleteMapping(this.mapping, struct.content.type);
			});
			transaction.changed.forEach(delType);
			transaction.changedParentTypes.forEach(delType);
			let tr = replaceChangedChildren(this._tr, this.createDocumentContent());
			newError = this.updateInvalidContentError();
			if (this._invalidContentError === null) restoreRelativeSelection(tr, selection, this, oldDoc);
			tr = tr.setMeta(ySyncPluginKey, {
				isChangeOrigin: true,
				isUndoRedoOperation
			});
			if (this.beforeTransactionSelection !== null && this._isLocalCursorInView()) tr.scrollIntoView();
			this.view.dispatch(tr);
		});
		this.notifyInvalidContent(newError);
	}
	_prosemirrorChanged(doc) {
		if (this._invalidContentError !== null) return;
		const syncState = getSyncPluginState(this.view.state);
		if (syncState.snapshot != null || syncState.prevSnapshot != null) return;
		this.doc.transact(() => {
			updateYFragment(this.doc, this.type, doc, this);
			this.hasSharedContent || (this.hasSharedContent = this.type.length > 0);
			this.beforeTransactionSelection = getRelativeSelection(this, this.view.state);
		}, ySyncPluginKey);
	}
	initView(prosemirrorView) {
		if (this.prosemirrorView != null) this.destroy();
		this.prosemirrorView = prosemirrorView;
		this.doc.on("beforeAllTransactions", this.beforeAllTransactions);
		this.doc.on("afterAllTransactions", this.afterAllTransactions);
		this.type.observeDeep(this._observeFunction);
	}
	destroy() {
		if (this.prosemirrorView == null) return;
		this.prosemirrorView = null;
		this.type.unobserveDeep(this._observeFunction);
		this.doc.off("beforeAllTransactions", this.beforeAllTransactions);
		this.doc.off("afterAllTransactions", this.afterAllTransactions);
	}
};
//#endregion
//#region src/lib/utils/positions/clearPositionMigrations.ts
const migrationPrefix = "__tiptap_position_migrations:";
const clearPositionMigrations = (document, transaction) => {
	const stores = [];
	document.share.forEach((type, name) => {
		if (!name.startsWith(migrationPrefix) || transaction && !transaction.changed.has(type)) return;
		const store = document.getMap(name);
		if (store.size > 0) stores.push(store);
	});
	if (stores.length === 0) return;
	document.transact((transaction) => {
		transaction.meta.set("addToHistory", false);
		stores.forEach((store) => store.clear());
	}, clearPositionMigrations);
};
//#endregion
//#region src/lib/plugins/ySyncPlugin.ts
const defaultColors = [{
	light: "#ecd44433",
	dark: "#ecd444"
}];
/** Binds a Yjs XML fragment to the editor document. The fragment must belong to a Yjs document. */
const ySyncPlugin = (yXmlFragment, { colors = defaultColors, colorMapping = /* @__PURE__ */ new Map(), permanentUserData = null, onFirstRender = () => {}, mapping, onInvalidContent } = {}) => {
	let initialContentChanged = false;
	const binding = new ProsemirrorBinding(yXmlFragment, mapping, onInvalidContent);
	return new Plugin({
		filterTransaction: (transaction) => binding.invalidContentError === null || !transaction.docChanged || transaction.getMeta(ySyncPluginKey) !== void 0,
		props: { editable: (state) => {
			const syncState = getSyncPluginState(state);
			return binding.invalidContentError === null && syncState.snapshot == null && syncState.prevSnapshot == null;
		} },
		key: ySyncPluginKey,
		state: {
			init: (_initargs, _state) => {
				return {
					type: yXmlFragment,
					doc: binding.doc,
					binding,
					snapshot: null,
					prevSnapshot: null,
					isChangeOrigin: false,
					isUndoRedoOperation: false,
					addToHistory: true,
					colors,
					colorMapping,
					permanentUserData
				};
			},
			apply: (tr, pluginState) => {
				const change = tr.getMeta(ySyncPluginKey);
				if (change !== void 0) pluginState = Object.assign({}, pluginState, change);
				if (tr.docChanged) pluginState.addToHistory = tr.getMeta("addToHistory") !== false;
				pluginState.isChangeOrigin = change !== void 0 && !!change.isChangeOrigin;
				pluginState.isUndoRedoOperation = change !== void 0 && !!change.isChangeOrigin && !!change.isUndoRedoOperation;
				if (binding.prosemirrorView === null || change === void 0 || change.snapshot == null && change.prevSnapshot == null) return pluginState;
				eventloop.timeout(0, () => {
					if (binding.prosemirrorView == null) return;
					if (change.restore == null) {
						binding._renderSnapshot(change.snapshot, change.prevSnapshot, pluginState);
						return;
					}
					if (binding.invalidContentError !== null) {
						binding.unrenderSnapshot();
						return;
					}
					binding._renderSnapshot(change.snapshot, change.snapshot, pluginState);
					binding.mux(() => {
						const activeView = binding.prosemirrorView;
						if (!activeView) return;
						activeView.dispatch(binding._tr.setMeta(ySyncPluginKey, {
							restore: false,
							snapshot: null,
							prevSnapshot: null,
							isChangeOrigin: true
						}));
						binding._prosemirrorChanged(activeView.state.doc);
					});
				});
				return pluginState;
			}
		},
		view: (view) => {
			const clearMigrations = (transaction) => clearPositionMigrations(binding.doc, transaction);
			clearPositionMigrations(binding.doc);
			binding.doc.on("afterTransaction", clearMigrations);
			binding.initView(view);
			if (mapping == null) binding._forceRerender();
			onFirstRender();
			return {
				update: () => {
					const pluginState = getSyncPluginState(view.state);
					if (pluginState.snapshot == null && pluginState.prevSnapshot == null) {
						const emptyDocument = view.state.doc.type.createAndFill();
						if (!emptyDocument) throw new Error("The schema cannot create an empty document");
						if (initialContentChanged || view.state.doc.content.findDiffStart(emptyDocument.content) !== null) {
							initialContentChanged = true;
							if (pluginState.addToHistory === false && !pluginState.isChangeOrigin) {
								const yUndoPluginState = yUndoPluginKey.getState(view.state);
								const um = yUndoPluginState && yUndoPluginState.undoManager;
								if (um) um.stopCapturing();
							}
							binding.mux(() => {
								pluginState.doc.transact((tr) => {
									tr.meta.set("addToHistory", pluginState.addToHistory);
									binding._prosemirrorChanged(view.state.doc);
								}, ySyncPluginKey);
							});
						}
					}
				},
				destroy: () => {
					binding.doc.off("afterTransaction", clearMigrations);
					binding.destroy();
				}
			};
		}
	});
};
//#endregion
//#region src/lib/plugins/getUndoPluginState.ts
function getUndoPluginState(state) {
	const pluginState = yUndoPluginKey.getState(state);
	if (!pluginState) throw new Error("The editor requires yUndoPlugin");
	return pluginState;
}
//#endregion
//#region src/lib/plugins/yUndoPlugin.ts
const restoreHistory = (state, direction) => {
	const syncState = getSyncPluginState(state);
	if (syncState.binding.invalidContentError !== null || syncState.snapshot != null || syncState.prevSnapshot != null) return false;
	const undoManager = getUndoPluginState(state).undoManager;
	if (undoManager != null) {
		undoManager[direction]();
		return true;
	}
};
/** Undoes a local change through the editor's Yjs undo manager. */
const undo = (state) => restoreHistory(state, "undo");
/** Redoes a local change through the editor's Yjs undo manager. */
const redo = (state) => restoreHistory(state, "redo");
const defaultProtectedNodes = /* @__PURE__ */ new Set(["paragraph"]);
/** Keeps protected structural nodes when an undo operation would delete them. */
const defaultDeleteFilter = (item, protectedNodes) => !(item instanceof Item) || !(item.content instanceof ContentType) || !(item.content.type instanceof Text || item.content.type instanceof XmlElement && protectedNodes.has(item.content.type.nodeName)) || item.content.type._length === 0;
/** Tracks local Yjs changes for undo and redo while preserving remote changes. */
const yUndoPlugin = ({ protectedNodes = defaultProtectedNodes, trackedOrigins = [], undoManager = null } = {}) => new Plugin({
	key: yUndoPluginKey,
	state: {
		init: (_, state) => {
			const syncState = getSyncPluginState(state);
			const destroyListeners = /* @__PURE__ */ new Set();
			let manager = undoManager;
			if (!manager) {
				var _syncState$doc$_obser;
				const before = new Set(syncState.doc._observers.get("destroy"));
				manager = new UndoManager(syncState.type, {
					trackedOrigins: /* @__PURE__ */ new Set([ySyncPluginKey, ...trackedOrigins]),
					deleteFilter: (item) => defaultDeleteFilter(item, protectedNodes),
					captureTransaction: (transaction) => transaction.meta.get("addToHistory") !== false
				});
				((_syncState$doc$_obser = syncState.doc._observers.get("destroy")) !== null && _syncState$doc$_obser !== void 0 ? _syncState$doc$_obser : /* @__PURE__ */ new Set()).forEach((listener) => {
					if (!before.has(listener)) destroyListeners.add(listener);
				});
			}
			return {
				undoManager: manager,
				prevSel: null,
				hasUndoOps: manager.undoStack.length > 0,
				hasRedoOps: manager.redoStack.length > 0,
				destroyListeners
			};
		},
		apply: (_, value, oldState, state) => {
			const binding = getSyncPluginState(state).binding;
			const canMapSelection = binding && binding.invalidContentError === null;
			return {
				...value,
				prevSel: canMapSelection ? getRelativeSelection(binding, oldState) : value.prevSel,
				hasUndoOps: value.undoManager.undoStack.length > 0,
				hasRedoOps: value.undoManager.redoStack.length > 0
			};
		}
	},
	view: (view) => {
		const syncState = getSyncPluginState(view.state);
		const { undoManager: manager, destroyListeners } = getUndoPluginState(view.state);
		manager.on("stack-item-added", ({ stackItem }) => {
			const binding = syncState.binding;
			if (binding) {
				const selection = manager.undoing || manager.redoing ? binding.beforeTransactionSelection : getUndoPluginState(view.state).prevSel;
				stackItem.meta.set(binding, selection);
			}
		});
		return { destroy: () => {
			manager.destroy();
			destroyListeners.forEach((listener) => manager.doc.off("destroy", listener));
			destroyListeners.clear();
		} };
	}
});
//#endregion
//#region src/lib/utils/conversion/prosemirrorToYXmlFragment.ts
/** Converts a ProseMirror document into a new or existing Yjs XML fragment. */
function prosemirrorToYXmlFragment(doc, xmlFragment) {
	var _type$doc;
	const type = xmlFragment || new Y.XmlFragment();
	const ydoc = (_type$doc = type.doc) !== null && _type$doc !== void 0 ? _type$doc : { transact: (callback) => callback() };
	updateYFragment(ydoc, type, doc, {
		mapping: /* @__PURE__ */ new Map(),
		isOMark: /* @__PURE__ */ new Map()
	});
	return type;
}
//#endregion
//#region src/lib/utils/conversion/prosemirrorToYDoc.ts
/** Creates a Yjs document from a ProseMirror document. */
function prosemirrorToYDoc(doc, xmlFragment = "prosemirror") {
	const ydoc = new Y.Doc();
	const type = ydoc.getXmlFragment(xmlFragment);
	if (!type.doc) return ydoc;
	prosemirrorToYXmlFragment(doc, type);
	return type.doc;
}
//#endregion
//#region src/lib/utils/conversion/prosemirrorJSONToYDoc.ts
/** Creates a Yjs document from ProseMirror JSON using the supplied schema. */
function prosemirrorJSONToYDoc(schema, state, xmlFragment = "prosemirror") {
	return prosemirrorToYDoc(Node.fromJSON(schema, state), xmlFragment);
}
//#endregion
//#region src/lib/utils/conversion/yXmlFragmentToProsemirrorJSON.ts
/** Reads ProseMirror JSON from a Yjs XML fragment. */
function yXmlFragmentToProsemirrorJSON(xmlFragment) {
	const items = xmlFragment.toArray();
	const serialize = (item) => {
		let response;
		if (item instanceof Y.XmlText) response = item.toDelta().map((d) => {
			const text = {
				type: "text",
				text: d.insert
			};
			const attributes = d.attributes;
			if (attributes) text.marks = Object.keys(attributes).map((type_) => {
				const attrs = attributes[type_];
				const mark = { type: yattr2markname(type_) };
				if (Object.keys(attrs).length) mark.attrs = attrs;
				return mark;
			});
			return text;
		});
		else if (item instanceof Y.XmlElement) {
			response = { type: item.nodeName };
			const attrs = item.getAttributes();
			if (Object.keys(attrs).length) response.attrs = attrs;
			const children = item.toArray();
			if (children.length) response.content = children.map(serialize).flat();
		} else error.unexpectedCase();
		return response;
	};
	return {
		type: "doc",
		content: items.map(serialize)
	};
}
//#endregion
//#region src/lib/utils/conversion/yDocToProsemirrorJSON.ts
/** Reads ProseMirror JSON from the named Yjs XML fragment. */
function yDocToProsemirrorJSON(ydoc, xmlFragment = "prosemirror") {
	return yXmlFragmentToProsemirrorJSON(ydoc.getXmlFragment(xmlFragment));
}
//#endregion
//#region src/lib/utils/conversion/yDocToProsemirror.ts
/** Creates a ProseMirror document from the named Yjs XML fragment. */
function yDocToProsemirror(schema, ydoc) {
	const state = yDocToProsemirrorJSON(ydoc);
	return Node.fromJSON(schema, state);
}
//#endregion
//#region src/lib/utils/conversion/prosemirrorJSONToYXmlFragment.ts
/** Converts ProseMirror JSON into a new or existing Yjs XML fragment. */
function prosemirrorJSONToYXmlFragment(schema, state, xmlFragment) {
	return prosemirrorToYXmlFragment(Node.fromJSON(schema, state), xmlFragment);
}
//#endregion
//#region src/lib/utils/conversion/yXmlFragmentToProsemirror.ts
/** Creates a ProseMirror document from a Yjs XML fragment. */
function yXmlFragmentToProsemirror(schema, xmlFragment) {
	const state = yXmlFragmentToProsemirrorJSON(xmlFragment);
	return Node.fromJSON(schema, state);
}
//#endregion
//#region src/lib/utils/conversion/createEmptyMeta.ts
const createEmptyMeta = () => ({
	mapping: /* @__PURE__ */ new Map(),
	isOMark: /* @__PURE__ */ new Map()
});
//#endregion
//#region src/lib/utils/conversion/yXmlFragmentToProseMirrorFragment.ts
/** Converts Yjs XML content to a ProseMirror fragment using the supplied schema. */
const yXmlFragmentToProseMirrorFragment = (yXmlFragment, schema) => {
	const fragmentContent = yXmlFragment.toArray().map((t) => {
		if (!(t instanceof Y.XmlElement)) throw error.methodUnimplemented();
		return createNodeFromYElement(t, schema, createEmptyMeta());
	}).filter((n) => n !== null);
	return Fragment.fromArray(fragmentContent);
};
//#endregion
//#region src/lib/utils/conversion/yXmlFragmentToProseMirrorRootNode.ts
/** Converts Yjs XML content to the schema's top-level document node. */
const yXmlFragmentToProseMirrorRootNode = (yXmlFragment, schema) => schema.topNodeType.create(null, yXmlFragmentToProseMirrorFragment(yXmlFragment, schema));
//#endregion
//#region src/lib/utils/conversion/initProseMirrorDoc.ts
/** Creates the initial ProseMirror document and its Yjs node mapping. */
const initProseMirrorDoc = (yXmlFragment, schema) => {
	const meta = createEmptyMeta();
	const fragmentContent = yXmlFragment.toArray().map((t) => {
		if (!(t instanceof Y.XmlElement)) throw error.methodUnimplemented();
		return createNodeFromYElement(t, schema, meta);
	}).filter((n) => n !== null);
	return {
		doc: schema.topNodeType.create(null, Fragment.fromArray(fragmentContent)),
		meta,
		mapping: meta.mapping
	};
};
//#endregion
export { ProsemirrorBinding, absolutePositionToRelativePosition, createDecorations, defaultAwarenessStateFilter, defaultCursorBuilder, defaultDeleteFilter, defaultProtectedNodes, defaultSelectionBuilder, findAbsolutePositionAfterStructuralChange, getRelativeSelection, initProseMirrorDoc, isMisresolvedAfterStructuralChange, isMisresolvedTextPosition, isStructuralTransaction, isVisible, prosemirrorJSONToYDoc, prosemirrorJSONToYXmlFragment, prosemirrorToYDoc, prosemirrorToYXmlFragment, redo, relativePositionToAbsolutePosition, setMeta, undo, updateYFragment, yCursorPlugin, yCursorPluginKey, yDocToProsemirror, yDocToProsemirrorJSON, ySyncPlugin, ySyncPluginKey, yUndoPlugin, yUndoPluginKey, yXmlFragmentToProseMirrorFragment, yXmlFragmentToProseMirrorRootNode, yXmlFragmentToProsemirror, yXmlFragmentToProsemirrorJSON };

