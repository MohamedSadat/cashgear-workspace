// Cash Gear's paid plans (Phase 18, M18.2): the workspace's plan and the plans offered, a checkout
// and a plan change, and Paddle's portal, through Workspace's API (`/workspaces/{id}/billing/*`).
// The checkout and the portal are Paddle's own pages: the app only opens the links the server makes,
// and never sees a card or payment detail. Offered only once the server's `/version` says it has
// billing (production's server is deployed after its web app).
import type { ApiClient } from '@cgw/api';
import type { Id } from '@cgw/workspace';

export interface BillingPrice {
  /** In the currency's smallest unit, as Paddle's catalogue holds it. */
  amount: string;
  currency: string;
  interval: string | null;
  frequency: number;
}

export interface BillingPlan {
  id: string;
  nameEn: string;
  nameAr: string;
  monthlyTokens: number;
  embeddingsMonthlyTokens: number;
  price: BillingPrice | null;
}

export interface Billing {
  plans: BillingPlan[];
  planId: string | null;
  status: 'none' | 'active' | 'trialing' | 'past_due' | 'paused' | 'canceled';
  periodEndsAt: string | null;
  scheduledAction: 'cancel' | 'pause' | null;
  scheduledAt: string | null;
  canManage: boolean;
  checkoutPending: boolean;
}

/** A refusal by its code (`billing.subscribed`, `billing.provider`, `access.denied`…), or `offline`. */
export class BillingError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface BillingApi {
  /** Whether the server offers billing (`/version`'s `billing`; none: a server before 0.18.0). */
  offered(): Promise<boolean>;
  state(workspaceId: Id): Promise<Billing>;
  checkout(workspaceId: Id, planId: string, language: 'en' | 'ar'): Promise<string>;
  changePlan(workspaceId: Id, planId: string): Promise<Billing>;
  portal(workspaceId: Id): Promise<string>;
  refresh(workspaceId: Id): Promise<Billing>;
}

type Answer<T> = Promise<{ data?: T; error?: unknown; response: Response }>;

async function data<T>(request: Answer<T>): Promise<T> {
  let result: Awaited<Answer<T>>;
  try {
    result = await request;
  } catch {
    throw new BillingError('offline');
  }
  if (result.response.ok && result.data !== undefined) return result.data;
  const body = result.error as { code?: unknown } | undefined;
  throw new BillingError(typeof body?.code === 'string' ? body.code : 'server.error');
}

const count = (value: number | string) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const STATUSES = ['none', 'active', 'trialing', 'past_due', 'paused', 'canceled'] as const;

type BillingDto = {
  plans: {
    id: string;
    nameEn: string;
    nameAr: string;
    monthlyTokens: number | string;
    embeddingsMonthlyTokens: number | string;
    price: null | {
      amount: string;
      currency: string;
      interval: null | string;
      frequency: number | string;
    };
  }[];
  planId?: string | null;
  status: string;
  periodEndsAt?: string | null;
  scheduledAction?: string | null;
  scheduledAt?: string | null;
  canManage: boolean;
  checkoutPending?: boolean;
};

export function billingOf(dto: BillingDto): Billing {
  return {
    plans: dto.plans.map((p) => ({
      id: p.id,
      nameEn: p.nameEn,
      nameAr: p.nameAr,
      monthlyTokens: count(p.monthlyTokens),
      embeddingsMonthlyTokens: count(p.embeddingsMonthlyTokens),
      price: p.price
        ? {
            amount: p.price.amount,
            currency: p.price.currency,
            interval: p.price.interval,
            frequency: count(p.price.frequency) || 1,
          }
        : null,
    })),
    planId: dto.planId ?? null,
    status: (STATUSES as readonly string[]).includes(dto.status)
      ? (dto.status as Billing['status'])
      : 'none',
    periodEndsAt: dto.periodEndsAt ?? null,
    scheduledAction:
      dto.scheduledAction === 'cancel' || dto.scheduledAction === 'pause'
        ? dto.scheduledAction
        : null,
    scheduledAt: dto.scheduledAt ?? null,
    canManage: dto.canManage,
    checkoutPending: dto.checkoutPending ?? false,
  };
}

/** A price as the person's language writes money: its amount from the currency's smallest unit. */
export function priceText(price: BillingPrice, language: string): string {
  // Arabic names the currency (9.00 دولار أمريكي): its sign there is Latin (US$).
  const format = new Intl.NumberFormat(language, {
    style: 'currency',
    currency: price.currency,
    currencyDisplay: language.startsWith('ar') ? 'name' : 'symbol',
  });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(Number(price.amount) / 10 ** digits);
}

export function cloudBillingApi(api: ApiClient): BillingApi {
  const path = (workspaceId: Id) => ({ params: { path: { workspaceId } } });
  let offered: Promise<boolean> | null = null;
  return {
    offered() {
      offered ??= data(api.GET('/api/v1/version')).then(
        (version) => (version as { billing?: boolean }).billing === true,
        () => {
          offered = null;
          return false;
        },
      );
      return offered;
    },
    async state(workspaceId) {
      return billingOf(
        await data(api.GET('/api/v1/workspaces/{workspaceId}/billing', path(workspaceId))),
      );
    },
    async checkout(workspaceId, planId, language) {
      const link = await data(
        api.POST('/api/v1/workspaces/{workspaceId}/billing/checkout', {
          ...path(workspaceId),
          body: { planId, language },
        }),
      );
      return link.url;
    },
    async changePlan(workspaceId, planId) {
      return billingOf(
        await data(
          api.POST('/api/v1/workspaces/{workspaceId}/billing/plan', {
            ...path(workspaceId),
            body: { planId },
          }),
        ),
      );
    },
    async portal(workspaceId) {
      return (
        await data(api.POST('/api/v1/workspaces/{workspaceId}/billing/portal', path(workspaceId)))
      ).url;
    },
    async refresh(workspaceId) {
      return billingOf(
        await data(api.POST('/api/v1/workspaces/{workspaceId}/billing/refresh', path(workspaceId))),
      );
    },
  };
}
