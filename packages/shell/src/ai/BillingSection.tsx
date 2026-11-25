// Settings → AI's plan (Phase 18, M18.2): owners and admins see the workspace's paid plan and the
// plans offered, with Paddle's prices; owners subscribe in Paddle's checkout (a new tab on the web,
// the system browser on the desktop), switch plan at once, and open Paddle's portal for the payment
// method, invoices and cancelling. While a checkout waits to be paid the plan is read again every
// 5 s (the server asks Paddle), so it shows within a minute of paying. Loaded with Settings → AI's
// plan only, its words a section of their own.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSection } from '../i18n/sections';
import {
  BillingError,
  priceText,
  type Billing,
  type BillingApi,
  type BillingPlan,
} from './billing';
import { billingWords } from './billingWords';

const PROVIDER = 'Paddle';
/** How often, and how long, a checkout waiting to be paid is read again. */
const POLL_MS = 5000;
const POLL_FOR_MS = 10 * 60 * 1000;

export interface BillingSectionProps {
  workspaceId: string;
  api: BillingApi;
  /** Web: a tab opened in the click, sent to the link when it comes; desktop: the system browser. */
  open: (link: Promise<string>) => void;
  /** The workspace's AI settings read again (the allowance follows the plan). */
  onPlanChanged: () => void;
}

export default function BillingSection({
  workspaceId,
  api,
  open,
  onPlanChanged,
}: BillingSectionProps) {
  useSection(billingWords);
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const [billing, setBilling] = useState<Billing | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [confirming, setConfirming] = useState<BillingPlan | null>(null);
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  // The plan as last drawn, for a read that comes back later.
  const latest = useRef<Billing | null>(null);
  latest.current = billing;
  const arabic = i18n.language === 'ar';
  const nameOf = (plan: BillingPlan) => (arabic ? plan.nameAr : plan.nameEn);
  const number = (n: number) => n.toLocaleString(i18n.language);
  const dateText = (iso: string) =>
    new Date(iso).toLocaleDateString(i18n.language, { dateStyle: 'medium' });

  const problem = useCallback(
    (error: unknown) => {
      const code = error instanceof BillingError ? error.code : 'server.error';
      setMessage({
        text: t(
          code === 'billing.subscribed'
            ? 'billing.subscribed'
            : code === 'access.denied'
              ? 'billing.ownersOnly'
              : 'billing.problem',
          { provider: PROVIDER },
        ),
        error: true,
      });
    },
    [t],
  );

  const take = useCallback(
    (next: Billing, before: Billing | null) => {
      setBilling(next);
      if (before && (before.planId !== next.planId || before.status !== next.status))
        onPlanChanged();
      if (!next.checkoutPending && next.planId) setWaitingSince(null);
    },
    [onPlanChanged],
  );

  useEffect(() => {
    let live = true;
    api.state(workspaceId).then(
      (state) => {
        if (!live) return;
        setBilling(state);
        if (state.checkoutPending) setWaitingSince(Date.now());
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [api, workspaceId]);

  // A checkout waiting to be paid: read again from Paddle every 5 s for ten minutes, and on focus.
  useEffect(() => {
    if (waitingSince === null) return;
    let live = true;
    const read = () =>
      api.refresh(workspaceId).then(
        (next) => {
          if (live) take(next, latest.current);
        },
        () => undefined,
      );
    const timer = setInterval(() => {
      if (Date.now() - waitingSince > POLL_FOR_MS) setWaitingSince(null);
      else void read();
    }, POLL_MS);
    const onFocus = () => void read();
    window.addEventListener('focus', onFocus);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [api, workspaceId, waitingSince, take]);

  const subscribe = (plan: BillingPlan) => {
    setMessage(null);
    const link = api.checkout(workspaceId, plan.id, arabic ? 'ar' : 'en');
    open(link);
    link.then(() => {
      setWaitingSince(Date.now());
      setMessage({ text: t('billing.opened', { provider: PROVIDER }), error: false });
    }, problem);
  };

  const switchTo = (plan: BillingPlan) => {
    setConfirming(null);
    setBusy(true);
    setMessage(null);
    api.changePlan(workspaceId, plan.id).then(
      (next) => {
        setBusy(false);
        take(next, billing);
      },
      (error: unknown) => {
        setBusy(false);
        problem(error);
      },
    );
  };

  const manage = () => {
    setMessage(null);
    const link = api.portal(workspaceId);
    open(link);
    link.catch(problem);
  };

  const refresh = () => {
    setBusy(true);
    api.refresh(workspaceId).then(
      (next) => {
        setBusy(false);
        take(next, billing);
      },
      (error: unknown) => {
        setBusy(false);
        problem(error);
      },
    );
  };

  const priceOf = (plan: BillingPlan) => {
    if (!plan.price) return t('billing.noPrice');
    const price = priceText(plan.price, i18n.language);
    if (plan.price.interval === 'year') return t('billing.priceYear', { price });
    return plan.price.frequency > 1
      ? t('billing.priceEvery', { price, count: plan.price.frequency })
      : t('billing.price', { price });
  };

  const current = billing?.plans.find((p) => p.id === billing.planId) ?? null;
  return (
    <section aria-labelledby={titleId} className="cgw-ai-billing" data-testid="billing">
      <h3 id={titleId}>{t('billing.title')}</h3>
      <p className="cgw-muted">{t('billing.note', { provider: PROVIDER })}</p>
      {!billing ? (
        <p className="cgw-muted" role="status">
          {t(failed ? 'billing.failed' : 'billing.loading')}
        </p>
      ) : (
        <>
          <p data-testid="billing-plan">
            {current ? t('billing.current', { plan: nameOf(current) }) : t('billing.none')}
            {current && billing.periodEndsAt && !billing.scheduledAction
              ? ' ' + t('billing.periodEnds', { date: dateText(billing.periodEndsAt) })
              : ''}
            {current && billing.scheduledAction === 'cancel' && billing.scheduledAt
              ? ' ' + t('billing.cancels', { date: dateText(billing.scheduledAt) })
              : ''}
            {current && billing.scheduledAction === 'pause' && billing.scheduledAt
              ? ' ' + t('billing.pauses', { date: dateText(billing.scheduledAt) })
              : ''}
          </p>
          {billing.status === 'past_due' && (
            <p className="cgw-ai-problem" data-testid="billing-past-due">
              {t('billing.pastDue', { provider: PROVIDER })}
            </p>
          )}
          {!current && (billing.status === 'canceled' || billing.status === 'paused') && (
            <p className="cgw-muted">
              {t('billing.ended', {
                status: t(
                  billing.status === 'canceled' ? 'billing.statusCanceled' : 'billing.statusPaused',
                ),
              })}
            </p>
          )}
          {!billing.canManage && <p className="cgw-muted">{t('billing.ownersOnly')}</p>}
          <ul className="cgw-ai-plans" aria-label={t('billing.plansLabel')}>
            {billing.plans.map((plan) => {
              const mine = plan.id === billing.planId;
              return (
                <li
                  key={plan.id}
                  className="cgw-ai-plan"
                  data-plan={plan.id}
                  aria-current={mine || undefined}
                >
                  <strong dir="auto">{nameOf(plan)}</strong>
                  <span>{priceOf(plan)}</span>
                  <span className="cgw-muted">
                    {t('billing.allowance', {
                      tokens: number(plan.monthlyTokens),
                      embeddings: number(plan.embeddingsMonthlyTokens),
                    })}
                  </span>
                  {mine ? (
                    <span className="cgw-muted">{t('billing.thisPlan')}</span>
                  ) : (
                    billing.canManage && (
                      <button
                        type="button"
                        className="cgw-button"
                        disabled={busy}
                        onClick={() => (current ? setConfirming(plan) : subscribe(plan))}
                      >
                        {current
                          ? t('billing.switch', { plan: nameOf(plan) })
                          : t('billing.subscribeTo', { plan: nameOf(plan) })}
                      </button>
                    )
                  )}
                </li>
              );
            })}
          </ul>
          {confirming && (
            <div
              className="cgw-ai-confirm"
              role="group"
              aria-label={t('billing.switch', { plan: nameOf(confirming) })}
            >
              <p>{t('billing.switchConfirm', { plan: nameOf(confirming), provider: PROVIDER })}</p>
              <button type="button" className="cgw-button" onClick={() => switchTo(confirming)}>
                {t('billing.switch', { plan: nameOf(confirming) })}
              </button>
              <button type="button" className="cgw-button" onClick={() => setConfirming(null)}>
                {t('frame.cancel')}
              </button>
            </div>
          )}
          {waitingSince !== null && (
            <p className="cgw-muted" role="status" data-testid="billing-waiting">
              {t('billing.waiting')}{' '}
              <button type="button" className="cgw-button" disabled={busy} onClick={refresh}>
                {t('billing.refresh')}
              </button>
            </p>
          )}
          {billing.canManage && billing.status !== 'none' && (
            <p>
              <button
                type="button"
                className="cgw-button"
                onClick={manage}
                data-testid="billing-manage"
              >
                {t('billing.manage')}
              </button>{' '}
              <span className="cgw-muted">{t('billing.manageNote', { provider: PROVIDER })}</span>
            </p>
          )}
        </>
      )}
      {message && (
        <p
          className={message.error ? 'cgw-ai-problem' : 'cgw-ai-notice'}
          role={message.error ? 'alert' : 'status'}
        >
          {message.text}
        </p>
      )}
    </section>
  );
}
