// A form view's answers and its link (Phase 16, M16.2), over the server's routes: read by the
// database's readers, made, changed and deleted with full access (the server decides). Loaded with
// the cloud, as the automations' host is; a member's answer itself is a row through the outbox.
import type { FormLink, FormLinkSettings, FormState, FormsHost } from '@cgw/database';
import type { ApiClient } from '@cgw/api';
import { KNOWN_VIEW_TYPES, SyncHttpError, type Id } from '@cgw/workspace';

/** What the host needs of the connection (cloud/cloud.ts's `automationsCloud()` gives it). */
export interface FormsCloud {
  api: ApiClient;
  online(): boolean;
}

type Answer<T> = Promise<{ data?: T; error?: unknown; response: Response }>;

/** The answer's data, or an error whose message is a notice code (`offline`, `access.denied`, ...). */
async function data<T>(request: Answer<T>): Promise<T> {
  let result: Awaited<Answer<T>>;
  try {
    result = await request;
  } catch (error) {
    throw new Error('offline', { cause: error });
  }
  if (result.response.ok) return result.data as T;
  const body = result.error as { code?: string; title?: string } | undefined;
  const failure = new SyncHttpError(
    result.response.status,
    body?.code ?? 'server.error',
    body?.title,
  );
  throw new Error(failure.code, { cause: failure });
}

interface FormLinkDto {
  id: Id;
  url: string;
  enabled: boolean;
  closesAt?: string | null;
  maxAnswers?: number | string | null;
  answers: number | string;
  state: string;
  createdAt: string;
}

const STATES = new Set(['open', 'off', 'closed', 'full']);

export const linkOf = (dto: FormLinkDto): FormLink => ({
  id: dto.id,
  url: dto.url,
  enabled: dto.enabled,
  closesAt: dto.closesAt ?? null,
  maxAnswers:
    dto.maxAnswers === null || dto.maxAnswers === undefined ? null : Number(dto.maxAnswers),
  answers: Number(dto.answers),
  state: (STATES.has(dto.state) ? dto.state : 'off') as FormLink['state'],
  createdAt: dto.createdAt,
});

export class ShellForms implements FormsHost {
  private viewTypes: number | null = null;

  constructor(
    private readonly cloud: FormsCloud,
    /** The views' host is told when the server's count of view types is known. */
    private readonly changed: () => void = () => undefined,
  ) {
    void this.readVersion();
  }

  /** The server's `/version`: how many view types it keeps (none sent: a server before 0.16.0). */
  private async readVersion() {
    try {
      const answer = await data(this.cloud.api.GET('/api/v1/version'));
      this.viewTypes = Number((answer as { viewTypes?: number }).viewTypes ?? 7);
    } catch {
      this.viewTypes = null;
    }
    this.changed();
  }

  online() {
    return this.cloud.online();
  }

  knowsForms() {
    return (this.viewTypes ?? 0) > KNOWN_VIEW_TYPES.indexOf('form');
  }

  private path(databaseId: Id, viewId: Id) {
    return { params: { path: { databaseId, viewId } } } as const;
  }

  async state(databaseId: Id, viewId: Id): Promise<FormState> {
    const answer = await data(
      this.cloud.api.GET(
        '/api/v1/databases/{databaseId}/views/{viewId}/form',
        this.path(databaseId, viewId),
      ),
    );
    return {
      answers: Number(answer.answers),
      link: answer.link ? linkOf(answer.link as FormLinkDto) : null,
      canManage: answer.canManage,
      linksAllowed: answer.linksAllowed,
    };
  }

  async createLink(databaseId: Id, viewId: Id, settings: FormLinkSettings): Promise<FormLink> {
    const answer = await data(
      this.cloud.api.POST('/api/v1/databases/{databaseId}/views/{viewId}/form/link', {
        ...this.path(databaseId, viewId),
        body: settings,
      }),
    );
    return linkOf(answer as FormLinkDto);
  }

  async updateLink(databaseId: Id, viewId: Id, settings: FormLinkSettings): Promise<FormLink> {
    const answer = await data(
      this.cloud.api.PUT('/api/v1/databases/{databaseId}/views/{viewId}/form/link', {
        ...this.path(databaseId, viewId),
        body: settings,
      }),
    );
    return linkOf(answer as FormLinkDto);
  }

  async deleteLink(databaseId: Id, viewId: Id): Promise<void> {
    await data(
      this.cloud.api.DELETE(
        '/api/v1/databases/{databaseId}/views/{viewId}/form/link',
        this.path(databaseId, viewId),
      ),
    );
  }
}
