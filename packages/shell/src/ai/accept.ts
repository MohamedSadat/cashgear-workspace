// Accept: a finished proposal made into an ordinary edit by the person (INTEGRATIONS.md, AI,
// Proposals), one action each: the selection replaced, a summary at the page's top, to-dos or an
// answer after the selection (or at the end), a new page under this one, a new database under it
// with a block showing it. Undo takes back the page's edits; the session's own operations make
// the new page and database, as any page or database the person makes.
import { build, parseMarkdown, withNewIds, type DocJSON } from '@cgw/doc';
import { insertAiContent, insertDatabaseView, type AiPlace, type BlockEditor } from '@cgw/editor';
import type { Id } from '@cgw/workspace';

type Editor = BlockEditor['editor'];
import type { ShellDatabaseHost } from '../database/host';
import { isRowRecord, type AnyPage, type WorkspaceSession } from '../session';
import { parseActionItems, parseDatabaseProposal } from './answers';
import { proposedDatabaseOps } from './database';
import type { AiSelection, AiTask } from './requests';

export type AcceptOutcome =
  | { kind: 'replaced' | 'inserted' | 'insertedBelow' }
  | { kind: 'pageCreated'; pageId: Id }
  | { kind: 'databaseCreated'; databaseId: Id }
  | { kind: 'refused' };

export interface AcceptContext {
  session: WorkspaceSession;
  page: AnyPage;
  /** The page's editor; null while it is not there. */
  editor: Editor | null;
  /** Whether the page may be changed here. */
  editable: boolean;
  databases: ShellDatabaseHost | null;
  /** A new database's first view's name, in the interface language. */
  tableName: string;
  /** The selection the panel was opened on, if any: to-dos and answers go after it. */
  selection: AiSelection | null;
}

/** A generated page's title (its first heading, else its first line) and the rest. */
export function splitTitle(markdown: string): { title: string; body: string } {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const first = lines.findIndex((line) => line.trim());
  if (first < 0) return { title: '', body: '' };
  const heading = /^#{1,6}\s+(.*)$/.exec(lines[first].trim());
  const title = (heading ? heading[1] : lines[first]).trim().replace(/[*_`]/g, '').slice(0, 300);
  return {
    title,
    body: lines
      .slice(first + 1)
      .join('\n')
      .trim(),
  };
}

/** An answer's blocks, then a line naming its sources as page mentions. */
export function answerBlocks(
  answer: string,
  sources: { pageId: Id }[],
  sourcesLabel: string,
): DocJSON[] {
  const blocks = parseMarkdown(answer).content ?? [];
  if (!sources.length) return blocks;
  const inline: DocJSON[] = [build.text(`${sourcesLabel}: `)];
  sources.forEach((source, index) => {
    if (index) inline.push(build.text(', '));
    inline.push({ type: 'pageMention', attrs: { pageId: source.pageId, blockId: null } });
  });
  return [...blocks, build.paragraph(...inline)];
}

const placeAfter = (selection: AiSelection | null): AiPlace =>
  selection ? { kind: 'after', pos: selection.to } : { kind: 'end' };

const inserted = (result: string): AcceptOutcome =>
  result === 'refused' ? { kind: 'refused' } : { kind: 'inserted' };

/** Makes the proposal an edit; `refused` when the page cannot take it here. */
export async function acceptProposal(
  task: AiTask,
  answer: { text: string; sources: { pageId: Id; title: string }[] },
  context: AcceptContext,
  labels: { sources: string },
): Promise<AcceptOutcome> {
  const { editor, session, page } = context;
  switch (task.action) {
    case 'rewrite': {
      if (!editor || !context.editable) return { kind: 'refused' };
      const { from, to, text } = task.selection;
      const result = insertAiContent(
        editor,
        { kind: 'replace', from, to, expect: text },
        answer.text,
      );
      return result === 'refused'
        ? { kind: 'refused' }
        : { kind: result === 'replaced' ? 'replaced' : 'insertedBelow' };
    }
    case 'summarise':
      if (!editor || !context.editable) return { kind: 'refused' };
      return inserted(insertAiContent(editor, { kind: 'top' }, answer.text));
    case 'actionItems': {
      if (!editor || !context.editable) return { kind: 'refused' };
      const items = parseActionItems(answer.text);
      const blocks = items.map((item) => build.todo(false, build.text(item)));
      return inserted(insertAiContent(editor, placeAfter(context.selection), blocks));
    }
    case 'ask': {
      if (!editor || !context.editable) return { kind: 'refused' };
      const blocks = answerBlocks(answer.text, answer.sources, labels.sources);
      return inserted(insertAiContent(editor, placeAfter(context.selection), blocks));
    }
    case 'generatePage': {
      const { title, body } = splitTitle(answer.text);
      // Under this page when it may be changed here (a row's body holds no sub-page), else at the
      // top of its section.
      const parentPageId = context.editable && !isRowRecord(page) ? page.id : null;
      const content = body ? withNewIds(parseMarkdown(body)) : undefined;
      const record = await session.createPage(
        { sectionId: page.sectionId, parentPageId, title },
        content,
      );
      return { kind: 'pageCreated', pageId: record.id };
    }
    case 'generateDatabase': {
      if (!editor || !context.editable || !context.databases || isRowRecord(page))
        return { kind: 'refused' };
      const proposal = parseDatabaseProposal(answer.text);
      const made = proposedDatabaseOps(
        proposal,
        {
          workspaceId: page.workspaceId,
          sectionId: page.sectionId,
          parentPageId: page.id,
          orderKey: session.keyFor(page.sectionId, page.id),
        },
        { table: context.tableName },
      );
      await context.databases.apply(made.ops);
      if (!editor.isDestroyed)
        insertDatabaseView(editor, { databaseId: made.databaseId, viewId: made.viewId });
      return { kind: 'databaseCreated', databaseId: made.databaseId };
    }
  }
}
