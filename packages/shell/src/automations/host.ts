// The database views' automations (Phase 15, M15.3), over the server's routes and the session:
// a database's rules and runs read from the server, rules saved as operations through the outbox
// (`automation.upsert`, with the browser's time zone for a workspace that has none), a button's
// press sent once (its own id) and never queued offline, the feed's `automation` change heard.
// Loaded with the first synced workspace's views, not with the app; its words are a section.
import type {
  AutomationRun,
  AutomationRunsPage,
  AutomationsHost,
  DatabaseAutomations,
  Person,
} from '@cgw/database';
import type { ApiClient } from '@cgw/api';
import {
  KNOWN_PROPERTY_TYPES,
  SyncHttpError,
  newOp,
  uuidv7,
  type AutomationRecord,
  type Id,
  type PropertyDef,
} from '@cgw/workspace';
import type { i18n as I18n } from 'i18next';
import { pageEvents } from '../page/PageMenu';
import type { WorkspaceSession } from '../session';
import { addSection } from '../i18n/sections';
import { automationsWords } from './words';

/** What the host needs of the connection (cloud/cloud.ts gives it). */
export interface AutomationsCloud {
  api: ApiClient;
  online(): boolean;
  /** Sends what waits now, so a rule saved reaches the server before the list is read again. */
  syncNow(): Promise<void>;
  /** The feed's `automation` changes, of any workspace. */
  onAutomations(listener: (workspaceId: Id) => void): () => void;
}

type Answer<T> = Promise<{ data?: T; error?: unknown; response: Response }>;

async function data<T>(request: Answer<T>): Promise<T> {
  let result: Awaited<Answer<T>>;
  try {
    result = await request;
  } catch (error) {
    if (error instanceof TypeError) throw new Error('offline', { cause: error });
    throw error;
  }
  if (result.response.ok) return result.data as T;
  const body = result.error as { code?: string; title?: string } | undefined;
  throw new SyncHttpError(result.response.status, body?.code ?? 'server.error', body?.title);
}

/** An error as a notice code, in the error's message (the views read it so). */
const asCode = (error: unknown) =>
  new Error(
    error instanceof SyncHttpError
      ? error.code
      : error instanceof Error
        ? error.message
        : 'server.error',
  );

interface PersonDto {
  id: Id;
  name: string;
}

const person = (p: PersonDto | null | undefined): Person | null =>
  p ? { id: p.id, name: p.name } : null;

interface AutomationDto {
  id: Id;
  workspaceId: Id;
  databaseId: Id;
  name: string;
  enabled: boolean;
  trigger: unknown;
  conditions: unknown;
  steps: unknown;
  authorId?: Id | null;
  version: number | string;
  createdAt: string;
  updatedAt: string;
}

export const ruleOf = (dto: AutomationDto): AutomationRecord => ({
  id: dto.id,
  workspaceId: dto.workspaceId,
  databaseId: dto.databaseId,
  name: dto.name,
  enabled: dto.enabled,
  trigger: dto.trigger as AutomationRecord['trigger'],
  conditions: (dto.conditions ?? null) as AutomationRecord['conditions'],
  steps: (dto.steps ?? []) as AutomationRecord['steps'],
  authorId: dto.authorId ?? null,
  version: Number(dto.version),
  createdAt: dto.createdAt,
  updatedAt: dto.updatedAt,
});

interface RunDto {
  id: Id;
  automationId: Id;
  automationName: string;
  databaseId: Id;
  rowId?: Id | null;
  rowTitle?: string | null;
  trigger: string;
  depth: number | string;
  actor?: PersonDto | null;
  author: PersonDto;
  status: string;
  reason?: string | null;
  steps: unknown;
  startedAt: string;
  endedAt?: string | null;
}

const runOf = (dto: RunDto): AutomationRun => ({
  id: dto.id,
  automationId: dto.automationId,
  automationName: dto.automationName,
  databaseId: dto.databaseId,
  rowId: dto.rowId ?? null,
  rowTitle: dto.rowTitle ?? null,
  trigger: dto.trigger,
  depth: Number(dto.depth),
  actor: person(dto.actor),
  author: person(dto.author)!,
  status: dto.status,
  reason: dto.reason ?? null,
  steps: Array.isArray(dto.steps) ? (dto.steps as AutomationRun['steps']) : [],
  startedAt: dto.startedAt,
  endedAt: dto.endedAt ?? null,
});

const runsOf = (page: { runs: RunDto[]; next?: string | null }): AutomationRunsPage => ({
  runs: page.runs.map(runOf),
  next: page.next ?? null,
});

/** The browser's IANA time zone, or null when it gives none. */
export const browserTimeZone = (): string | null => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
};

export class ShellAutomations implements AutomationsHost {
  private propertyTypes: number | null = null;
  /** Phase 17: the step kinds the server keeps (none sent: 4, a server before 0.17.0). */
  private stepKinds: number | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly off: () => void;

  constructor(
    private readonly cloud: AutomationsCloud,
    private readonly session: WorkspaceSession,
    /** The app's instance, which the press's notices are said in. */
    private readonly i18n: I18n,
    /** The host's listeners are told when the server's count of property types is known. */
    private readonly changed: () => void,
  ) {
    addSection(i18n, automationsWords);
    this.off = cloud.onAutomations((workspaceId) => {
      if (workspaceId === this.session.current?.id)
        for (const listener of this.listeners) listener();
    });
    void this.readVersion();
  }

  dispose() {
    this.off();
  }

  /** The server's `/version`: how many property types it knows (none sent: a server before 0.15.0). */
  private async readVersion() {
    try {
      const answer = await data(this.cloud.api.GET('/api/v1/version'));
      this.propertyTypes = Number((answer as { propertyTypes?: number }).propertyTypes ?? 20);
      this.stepKinds = Number((answer as { stepKinds?: number }).stepKinds ?? 4);
    } catch {
      this.propertyTypes = null;
      this.stepKinds = null;
    }
    this.changed();
  }

  online() {
    return this.cloud.online();
  }

  knowsButtons() {
    return (this.propertyTypes ?? 0) >= KNOWN_PROPERTY_TYPES.length;
  }

  private workspaceId(): Id {
    const id = this.session.current?.id;
    if (!id) throw new Error('not.found');
    return id;
  }

  async list(databaseId: Id): Promise<DatabaseAutomations> {
    try {
      const answer = await data(
        this.cloud.api.GET('/api/v1/databases/{databaseId}/automations', {
          params: { path: { databaseId } },
        }),
      );
      return {
        automations: answer.automations.map((item) => ({
          rule: ruleOf(item.rule as AutomationDto),
          author: person(item.author as PersonDto | null),
          lastRun: item.lastRun
            ? {
                status: item.lastRun.status,
                reason: item.lastRun.reason ?? null,
                startedAt: item.lastRun.startedAt,
              }
            : null,
        })),
        canManage: answer.canManage,
        canCallWebhooks: answer.canCallWebhooks,
        webhooks: answer.webhooks.map((w) => ({ id: w.id, name: w.name })),
        timeZone: answer.timeZone ?? null,
        allOff: answer.allOff,
        // Unknown yet: only what every server keeps.
        stepKinds: this.stepKinds ?? 4,
      };
    } catch (error) {
      throw asCode(error);
    }
  }

  async save(rule: AutomationRecord): Promise<void> {
    const workspaceId = this.workspaceId();
    // The saver's zone goes with it: a workspace made before 0.15.0 takes it for its first rule.
    const payload = { ...rule, workspaceId, timeZone: browserTimeZone() } as AutomationRecord;
    await this.session.apply([newOp('automation.upsert', workspaceId, rule.id, payload)]);
    await this.cloud.syncNow().catch(() => undefined);
  }

  async remove(rule: AutomationRecord): Promise<void> {
    const workspaceId = this.workspaceId();
    await this.session.apply([newOp('automation.delete', workspaceId, rule.id, {})]);
    await this.cloud.syncNow().catch(() => undefined);
  }

  async setEnabled(rule: AutomationRecord, enabled: boolean): Promise<void> {
    try {
      await data(
        this.cloud.api.PUT('/api/v1/workspaces/{workspaceId}/automations/{automationId}/enabled', {
          params: { path: { workspaceId: this.workspaceId(), automationId: rule.id } },
          body: { enabled },
        }),
      );
    } catch (error) {
      throw asCode(error);
    }
  }

  async runs(databaseId: Id, automationId: Id, before?: string | null) {
    try {
      return runsOf(
        (await data(
          this.cloud.api.GET('/api/v1/databases/{databaseId}/automations/{automationId}/runs', {
            params: { path: { databaseId, automationId }, query: before ? { before } : {} },
          }),
        )) as { runs: RunDto[]; next?: string | null },
      );
    } catch (error) {
      throw asCode(error);
    }
  }

  async rowRuns(databaseId: Id, rowId: Id, before?: string | null) {
    try {
      return runsOf(
        (await data(
          this.cloud.api.GET('/api/v1/databases/{databaseId}/rows/{rowId}/runs', {
            params: { path: { databaseId, rowId }, query: before ? { before } : {} },
          }),
        )) as { runs: RunDto[]; next?: string | null },
      );
    } catch (error) {
      throw asCode(error);
    }
  }

  /** Says it in the window's notice, in the interface language. */
  private say(key: string, options?: Record<string, unknown>) {
    const text = (this.i18n.t as unknown as (k: string, o?: Record<string, unknown>) => string)(
      `automations.press.${key}`,
      options,
    );
    pageEvents.dispatchEvent(new CustomEvent('notice', { detail: text }));
  }

  async press(databaseId: Id, rowId: Id, def: PropertyDef): Promise<void> {
    // Never queued: a press that waited offline would run when nobody expects it.
    if (!this.online()) return this.say('offline');
    try {
      const answer = await data(
        this.cloud.api.POST('/api/v1/databases/{databaseId}/rows/{rowId}/press', {
          params: { path: { databaseId, rowId } },
          body: { propertyId: def.id, pressId: uuidv7() },
        }),
      );
      const names = answer.automations.map((n) => `“${n}”`).join(', ');
      this.say('running', { names: names || `“${def.button?.label || def.name}”` });
    } catch (error) {
      const code = asCode(error).message;
      this.say(
        code === 'automation.none'
          ? 'none'
          : code === 'access.denied'
            ? 'denied'
            : code === 'offline'
              ? 'offline'
              : 'failed',
      );
    }
  }

  async groups() {
    try {
      const answer = await data(
        this.cloud.api.GET('/api/v1/workspaces/{workspaceId}/groups', {
          params: { path: { workspaceId: this.workspaceId() } },
        }),
      );
      return (answer as { groups: { id: Id; name: string }[] }).groups.map((g) => ({
        id: g.id,
        name: g.name,
      }));
    } catch {
      return [];
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
}
