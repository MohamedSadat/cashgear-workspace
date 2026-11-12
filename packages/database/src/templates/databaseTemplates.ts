// The built-in database templates (contract section 1: definitions in `@cgw/database`, not
// records): Tasks, Projects, Reading list, Meeting notes and Contacts, each with its properties,
// its views (a table, a board, a list, a calendar and a gallery between them) and a few sample
// rows, made in the interface language. `makeDatabase` turns a choice into the operations that make
// it: a `page.create` of kind `database` with its properties, a `view.upsert` per view, and a
// `page.create` of kind `row` per row (row templates included). Ids are new each time. Pure: the
// strings come in through `t`.
import { keysBetween, newOp, type Id, type Operation, type PageCreate } from '@cgw/workspace';
import {
  TITLE_PROPERTY,
  newOptionId,
  newPropertyId,
  type OptionColour,
  type PropertyDef,
  type PropertyId,
  type PropertyType,
  type SelectOption,
  type StatusGroup,
  type StatusOption,
  type Value,
  type ViewConfig,
  type ViewRecord,
  type ViewType,
} from '../core';
import type { DbT } from '../i18n';
import { emptyConfig } from '../model/viewConfig';
import { dateOfDay, dayNumber } from '../views/calendar/dates';

export type TemplateId = 'tasks' | 'projects' | 'readingList' | 'meetingNotes' | 'contacts';
export type TemplateChoice = TemplateId | 'blank';

export const TEMPLATE_IDS: readonly TemplateId[] = [
  'tasks',
  'projects',
  'readingList',
  'meetingNotes',
  'contacts',
];

export const TEMPLATE_ICONS: Record<TemplateChoice, string | null> = {
  blank: null,
  tasks: '✅',
  projects: '📁',
  readingList: '📚',
  meetingNotes: '🗒️',
  contacts: '📇',
};

/** Where the new database page goes (the shell decides). */
export interface DatabasePlace {
  workspaceId: Id;
  sectionId: Id;
  /** The page holding it (an inline database's page), or null at the top of the section. */
  parentPageId: Id | null;
  orderKey: string;
}

export interface MakeContext {
  t: DbT;
  newId(): Id;
  /** The person making it: a task's assignee in the samples (none when unknown). */
  me: Id | null;
  /** The person's calendar date and offset (sample dates are around it). */
  today: string;
  offsetMinutes: number;
  /** The time the records are stamped with (default: now). */
  now?: string;
}

export interface MadeDatabase {
  databaseId: Id;
  /** The first view (an inline block shows it). */
  viewId: Id;
  title: string;
  /** In the order to apply them. */
  ops: Operation[];
  /** For a preview and the tests: what the operations make. */
  properties: PropertyDef[];
  views: { id: Id; name: string; type: ViewType; config: ViewConfig }[];
  rows: { id: Id; title: string; values: Record<PropertyId, Value>; isTemplate: boolean }[];
}

interface Shape {
  title: string;
  properties: PropertyDef[];
  views: { name: string; type: ViewType; config: Partial<ViewConfig> }[];
  rows: { title: string; values: Record<PropertyId, Value>; isTemplate?: boolean }[];
}

// ---- Building blocks --------------------------------------------------------------------------

const option = (name: string, colour: OptionColour): SelectOption => ({
  id: newOptionId(),
  name,
  colour,
});
const statusOption = (name: string, colour: OptionColour, group: StatusGroup): StatusOption => ({
  ...option(name, colour),
  group,
});
const property = (
  type: PropertyType,
  name: string,
  extra: Partial<PropertyDef> = {},
): PropertyDef => ({
  id: newPropertyId(),
  name,
  type,
  ...extra,
});
const titleProperty = (name: string): PropertyDef => ({ id: TITLE_PROPERTY, name, type: 'title' });
const hidden = (...ids: PropertyId[]) => ({ order: [], hidden: ids, widths: {} });

function priority(t: DbT, name: string) {
  const high = option(t('templates.priorityHigh'), 'red');
  const medium = option(t('templates.priorityMedium'), 'yellow');
  const low = option(t('templates.priorityLow'), 'gray');
  return { def: property('select', name, { options: [high, medium, low] }), high, medium, low };
}

function dates(ctx: MakeContext) {
  const base = dayNumber(ctx.today);
  const day = (n: number) => dateOfDay(base + n);
  /** A date-time `hour:minute` on the person's clock, `n` days from today, as a UTC instant. */
  const at = (n: number, hour: number, minute = 0) => {
    const ms = (base + n) * 86_400_000 + (hour * 60 + minute - ctx.offsetMinutes) * 60_000;
    return `${new Date(ms).toISOString().slice(0, 19)}Z`;
  };
  return { day, at };
}

// ---- The templates ----------------------------------------------------------------------------

function tasks(ctx: MakeContext): Shape {
  const { t } = ctx;
  const { day } = dates(ctx);
  const notStarted = statusOption(t('templates.tasks.notStarted'), 'gray', 'todo');
  const inProgress = statusOption(t('templates.tasks.inProgress'), 'blue', 'inProgress');
  const done = statusOption(t('templates.tasks.done'), 'green', 'complete');
  const status = property('status', t('templates.tasks.status'), {
    options: [notStarted, inProgress, done],
  });
  const assignee = property('person', t('templates.tasks.assignee'));
  const due = property('date', t('templates.tasks.due'), { date: { includeTime: false } });
  const p = priority(t, t('templates.tasks.priority'));
  const me = ctx.me ? { [assignee.id]: [ctx.me] } : {};
  return {
    title: t('templates.tasks.name'),
    properties: [titleProperty(t('templates.tasks.title')), status, assignee, due, p.def],
    views: [
      {
        name: t('templates.tasks.viewBoard'),
        type: 'board',
        config: { group: { propertyId: status.id }, properties: hidden(status.id) },
      },
      {
        name: t('templates.tasks.viewAll'),
        type: 'table',
        config: { sorts: [{ propertyId: due.id, direction: 'asc' }] },
      },
      {
        name: t('templates.tasks.viewCalendar'),
        type: 'calendar',
        config: { calendarBy: due.id, properties: hidden(due.id) },
      },
      {
        name: t('templates.tasks.viewMine'),
        type: 'list',
        config: {
          filter: {
            kind: 'group',
            op: 'and',
            children: [
              {
                kind: 'condition',
                propertyId: assignee.id,
                operator: 'contains',
                value: { me: true },
              },
            ],
          },
          sorts: [{ propertyId: due.id, direction: 'asc' }],
          properties: hidden(assignee.id),
        },
      },
    ],
    rows: [
      {
        title: t('templates.tasks.row1'),
        values: {
          [status.id]: inProgress.id,
          [p.def.id]: p.high.id,
          [due.id]: { start: day(2) },
          ...me,
        },
      },
      {
        title: t('templates.tasks.row2'),
        values: {
          [status.id]: notStarted.id,
          [p.def.id]: p.medium.id,
          [due.id]: { start: day(5) },
        },
      },
      {
        title: t('templates.tasks.row3'),
        values: { [status.id]: done.id, [p.def.id]: p.low.id, [due.id]: { start: day(-1) }, ...me },
      },
      {
        title: t('templates.tasks.row4'),
        values: { [status.id]: notStarted.id, [due.id]: { start: day(7) } },
      },
    ],
  };
}

function projects(ctx: MakeContext): Shape {
  const { t } = ctx;
  const { day } = dates(ctx);
  const planned = statusOption(t('templates.projects.planned'), 'gray', 'todo');
  const active = statusOption(t('templates.projects.active'), 'blue', 'inProgress');
  const paused = statusOption(t('templates.projects.paused'), 'orange', 'inProgress');
  const completed = statusOption(t('templates.projects.completed'), 'green', 'complete');
  const status = property('status', t('templates.projects.status'), {
    options: [planned, active, paused, completed],
  });
  const owner = property('person', t('templates.projects.owner'));
  const span = property('date', t('templates.projects.dates'), { date: { includeTime: false } });
  const p = priority(t, t('templates.projects.priority'));
  const progress = property('number', t('templates.projects.progress'), {
    number: { format: 'percent', decimals: 0 },
  });
  const me = ctx.me ? { [owner.id]: [ctx.me] } : {};
  return {
    title: t('templates.projects.name'),
    properties: [
      titleProperty(t('templates.projects.title')),
      status,
      owner,
      span,
      p.def,
      progress,
    ],
    views: [
      { name: t('templates.projects.viewAll'), type: 'table', config: {} },
      {
        name: t('templates.projects.viewBoard'),
        type: 'board',
        config: { group: { propertyId: status.id }, properties: hidden(status.id) },
      },
      {
        name: t('templates.projects.viewCalendar'),
        type: 'calendar',
        config: { calendarBy: span.id, properties: hidden(span.id) },
      },
    ],
    rows: [
      {
        title: t('templates.projects.row1'),
        values: {
          [status.id]: active.id,
          [span.id]: { start: day(-7), end: day(21) },
          [p.def.id]: p.high.id,
          [progress.id]: 0.4,
          ...me,
        },
      },
      {
        title: t('templates.projects.row2'),
        values: {
          [status.id]: planned.id,
          [span.id]: { start: day(30), end: day(60) },
          [p.def.id]: p.medium.id,
          [progress.id]: 0,
        },
      },
      {
        title: t('templates.projects.row3'),
        values: {
          [status.id]: completed.id,
          [span.id]: { start: day(-90), end: day(-10) },
          [p.def.id]: p.low.id,
          [progress.id]: 1,
          ...me,
        },
      },
    ],
  };
}

function readingList(ctx: MakeContext): Shape {
  const { t } = ctx;
  const { day } = dates(ctx);
  const author = property('text', t('templates.readingList.author'));
  const book = option(t('templates.readingList.book'), 'blue');
  const article = option(t('templates.readingList.article'), 'purple');
  const podcast = option(t('templates.readingList.podcast'), 'orange');
  const type = property('select', t('templates.readingList.type'), {
    options: [book, article, podcast],
  });
  const toRead = statusOption(t('templates.readingList.toRead'), 'gray', 'todo');
  const reading = statusOption(t('templates.readingList.reading'), 'blue', 'inProgress');
  const read = statusOption(t('templates.readingList.read'), 'green', 'complete');
  const status = property('status', t('templates.readingList.status'), {
    options: [toRead, reading, read],
  });
  const stars = [1, 2, 3, 4, 5].map((n) => option('★'.repeat(n), 'yellow'));
  const rating = property('select', t('templates.readingList.rating'), { options: stars });
  const link = property('url', t('templates.readingList.link'));
  const finished = property('date', t('templates.readingList.finished'), {
    date: { includeTime: false },
  });
  return {
    title: t('templates.readingList.name'),
    properties: [
      titleProperty(t('templates.readingList.title')),
      author,
      type,
      status,
      rating,
      link,
      finished,
    ],
    views: [
      {
        name: t('templates.readingList.viewShelf'),
        type: 'gallery',
        config: {
          cover: { kind: 'pageCover' },
          cardSize: 'medium',
          properties: hidden(link.id, finished.id),
        },
      },
      { name: t('templates.readingList.viewAll'), type: 'table', config: {} },
      {
        name: t('templates.readingList.viewBoard'),
        type: 'board',
        config: { group: { propertyId: status.id }, properties: hidden(status.id, link.id) },
      },
    ],
    rows: [
      {
        title: t('templates.readingList.row1'),
        values: {
          [author.id]: t('templates.readingList.row1Author'),
          [type.id]: book.id,
          [status.id]: reading.id,
          [rating.id]: stars[4].id,
        },
      },
      {
        title: t('templates.readingList.row2'),
        values: {
          [author.id]: t('templates.readingList.row2Author'),
          [type.id]: book.id,
          [status.id]: toRead.id,
        },
      },
      {
        title: t('templates.readingList.row3'),
        values: {
          [author.id]: t('templates.readingList.row3Author'),
          [type.id]: book.id,
          [status.id]: read.id,
          [rating.id]: stars[3].id,
          [finished.id]: { start: day(-20) },
        },
      },
    ],
  };
}

function meetingNotes(ctx: MakeContext): Shape {
  const { t } = ctx;
  const { at } = dates(ctx);
  const date = property('date', t('templates.meetingNotes.date'), { date: { includeTime: true } });
  const standup = option(t('templates.meetingNotes.standup'), 'gray');
  const weekly = option(t('templates.meetingNotes.weekly'), 'blue');
  const planning = option(t('templates.meetingNotes.planning'), 'purple');
  const oneToOne = option(t('templates.meetingNotes.oneToOne'), 'green');
  const type = property('select', t('templates.meetingNotes.type'), {
    options: [standup, weekly, planning, oneToOne],
  });
  const attendees = property('person', t('templates.meetingNotes.attendees'));
  const me = ctx.me ? { [attendees.id]: [ctx.me] } : {};
  return {
    title: t('templates.meetingNotes.name'),
    properties: [titleProperty(t('templates.meetingNotes.title')), date, type, attendees],
    views: [
      {
        name: t('templates.meetingNotes.viewAll'),
        type: 'list',
        config: { sorts: [{ propertyId: date.id, direction: 'desc' }] },
      },
      {
        name: t('templates.meetingNotes.viewCalendar'),
        type: 'calendar',
        config: { calendarBy: date.id, properties: hidden(date.id) },
      },
      {
        name: t('templates.meetingNotes.viewByType'),
        type: 'table',
        config: {
          group: { propertyId: type.id },
          sorts: [{ propertyId: date.id, direction: 'desc' }],
        },
      },
    ],
    rows: [
      {
        title: t('templates.meetingNotes.row1'),
        values: { [date.id]: { start: at(0, 10) }, [type.id]: weekly.id, ...me },
      },
      {
        title: t('templates.meetingNotes.row2'),
        values: { [date.id]: { start: at(3, 13) }, [type.id]: planning.id, ...me },
      },
      {
        title: t('templates.meetingNotes.row3'),
        values: { [date.id]: { start: at(-1, 9, 30) }, [type.id]: standup.id },
      },
      {
        title: t('templates.meetingNotes.template'),
        values: { [type.id]: weekly.id },
        isTemplate: true,
      },
    ],
  };
}

function contacts(ctx: MakeContext): Shape {
  const { t } = ctx;
  const { day } = dates(ctx);
  const company = property('text', t('templates.contacts.company'));
  const role = property('text', t('templates.contacts.role'));
  const email = property('email', t('templates.contacts.email'));
  const phone = property('phone', t('templates.contacts.phone'));
  const customer = option(t('templates.contacts.customer'), 'blue');
  const supplier = option(t('templates.contacts.supplier'), 'orange');
  const partner = option(t('templates.contacts.partner'), 'green');
  const tags = property('multiSelect', t('templates.contacts.tags'), {
    options: [customer, supplier, partner],
  });
  const last = property('date', t('templates.contacts.lastContacted'), {
    date: { includeTime: false },
  });
  return {
    title: t('templates.contacts.name'),
    properties: [
      titleProperty(t('templates.contacts.title')),
      company,
      role,
      email,
      phone,
      tags,
      last,
    ],
    views: [
      { name: t('templates.contacts.viewAll'), type: 'table', config: {} },
      {
        name: t('templates.contacts.viewCards'),
        type: 'gallery',
        config: { cover: { kind: 'none' }, cardSize: 'small', properties: hidden(last.id) },
      },
      {
        name: t('templates.contacts.viewByTag'),
        type: 'list',
        config: { group: { propertyId: tags.id }, properties: hidden(tags.id, phone.id) },
      },
    ],
    rows: [
      {
        title: t('templates.contacts.row1'),
        values: {
          [company.id]: t('templates.contacts.row1Company'),
          [role.id]: t('templates.contacts.row1Role'),
          [email.id]: 'layla@example.com',
          [phone.id]: '+20 100 555 0101',
          [tags.id]: [customer.id],
          [last.id]: { start: day(-3) },
        },
      },
      {
        title: t('templates.contacts.row2'),
        values: {
          [company.id]: t('templates.contacts.row2Company'),
          [role.id]: t('templates.contacts.row2Role'),
          [email.id]: 'omar@example.com',
          [phone.id]: '+20 100 555 0102',
          [tags.id]: [supplier.id],
          [last.id]: { start: day(-12) },
        },
      },
      {
        title: t('templates.contacts.row3'),
        values: {
          [company.id]: t('templates.contacts.row3Company'),
          [role.id]: t('templates.contacts.row3Role'),
          [email.id]: 'sara@example.com',
          [tags.id]: [partner.id, customer.id],
        },
      },
    ],
  };
}

function blank(ctx: MakeContext): Shape {
  return {
    title: '',
    properties: [titleProperty(ctx.t('templates.titleProperty'))],
    views: [{ name: ctx.t('templates.tableView'), type: 'table', config: {} }],
    rows: [],
  };
}

const SHAPES: Record<TemplateChoice, (ctx: MakeContext) => Shape> = {
  blank,
  tasks,
  projects,
  readingList,
  meetingNotes,
  contacts,
};

/** The names of a template's views, for the picker (made with throwaway ids). */
export function templateViews(
  choice: TemplateChoice,
  ctx: MakeContext,
): { name: string; type: ViewType }[] {
  return SHAPES[choice](ctx).views.map(({ name, type }) => ({ name, type }));
}

// ---- The operations ---------------------------------------------------------------------------

/** The operations that make a database from a template (or a blank one) at a place. */
export function makeDatabase(
  choice: TemplateChoice,
  place: DatabasePlace,
  ctx: MakeContext,
): MadeDatabase {
  const shape = SHAPES[choice](ctx);
  const now = ctx.now ?? new Date().toISOString();
  const databaseId = ctx.newId();
  const ops: Operation[] = [];
  const page: PageCreate = {
    id: databaseId,
    workspaceId: place.workspaceId,
    sectionId: place.sectionId,
    parentPageId: place.parentPageId,
    orderKey: place.orderKey,
    kind: 'database',
    title: shape.title,
    icon: TEMPLATE_ICONS[choice],
    coverAssetId: null,
    isTemplate: false,
    templateOfPageId: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    trashedAt: null,
    trashRootId: null,
    database: { properties: shape.properties },
  };
  ops.push(newOp('page.create', place.workspaceId, databaseId, page));

  const viewKeys = keysBetween(null, null, shape.views.length);
  const views = shape.views.map((v, i) => {
    const base = emptyConfig(v.type);
    const config: ViewConfig = {
      ...base,
      ...(v.type === 'gallery'
        ? { cover: { kind: 'pageCover' as const }, cardSize: 'medium' as const }
        : {}),
      ...(v.type === 'calendar' ? { calendarBy: null } : {}),
      ...v.config,
      properties: { ...base.properties, ...v.config.properties },
    };
    const view: ViewRecord = {
      id: ctx.newId(),
      workspaceId: place.workspaceId,
      databaseId,
      name: v.name,
      type: v.type,
      orderKey: viewKeys[i],
      config,
      version: 1,
      createdAt: now,
    };
    ops.push(newOp('view.upsert', place.workspaceId, view.id, view));
    return { id: view.id, name: view.name, type: view.type, config };
  });

  const rowKeys = keysBetween(null, null, shape.rows.length);
  const rows = shape.rows.map((r, i) => {
    const id = ctx.newId();
    const row: PageCreate = {
      id,
      workspaceId: place.workspaceId,
      sectionId: place.sectionId,
      parentPageId: databaseId,
      orderKey: rowKeys[i],
      kind: 'row',
      title: r.title,
      icon: null,
      coverAssetId: null,
      isTemplate: r.isTemplate ?? false,
      templateOfPageId: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
      trashedAt: null,
      trashRootId: null,
      row: { values: r.values },
    };
    ops.push(newOp('page.create', place.workspaceId, id, row));
    return { id, title: r.title, values: r.values, isTemplate: r.isTemplate ?? false };
  });

  return {
    databaseId,
    viewId: views[0].id,
    title: shape.title,
    ops,
    properties: shape.properties,
    views,
    rows,
  };
}
