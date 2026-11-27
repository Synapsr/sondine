import type { ComputeBillingInput, ComputeBillingOutcome, ComputeQuota } from "@sondine/api";
import { Badge } from "@sondine/ui/components/badge";
import { Button } from "@sondine/ui/components/button";
import { Meter, MeterLabel, MeterValue } from "@sondine/ui/components/meter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { CLOUD_WAITLIST_URL } from "../../../shared/cloud";
import { errorMessage, orpc } from "../../core/orpc";
import { useLocale } from "../../i18n/locale";
import { m } from "../../paraglide/messages.js";

// The Cloud's plan, from the app (ADR 047): the trial, the Founder plan, this
// period's hours and the top-ups. Paying, the card, invoices and cancelling
// happen on Stripe's pages, in the browser; this Mac only asks its server for
// the page. Once one is open, the plan is read again every few seconds, and
// when the window comes back, until it changes.

/** How long the plan is read again after a Stripe page opened. */
const WAIT_MS = 15 * 60_000;
const POLL_MS = 5_000;

const billingText: Record<Exclude<ComputeBillingOutcome, "opened">, () => string> = {
  "not-allowed": () => m.cloud_not_allowed(),
  unavailable: () => m.cloud_unavailable(),
  closed: () => m.cloud_closed(),
  mismatch: () => m.compute_mismatch(),
};

/** How full the wave is, as a share of its real places; nothing when there is none. */
export function WaveGauge() {
  const wave = useQuery({ ...orpc.compute.wave.queryOptions(), retry: false, staleTime: 60_000 });
  if (wave.data == null) return null;
  const { percent, full } = wave.data;
  return (
    <div className="flex flex-col gap-xs">
      <Meter value={percent} high={99} aria-label={m.cloud_wave()}>
        <MeterLabel>{full ? m.cloud_wave_full() : m.cloud_wave()}</MeterLabel>
        <MeterValue>{() => m.cloud_wave_taken({ percent: String(percent) })}</MeterValue>
      </Meter>
      {full ? (
        <p className="text-body-s text-cte-text-muted">
          {m.cloud_wave_full_detail()}{" "}
          <a className="underline" href={CLOUD_WAITLIST_URL} target="_blank" rel="noreferrer">
            {m.cloud_wave_notify()}
          </a>
        </p>
      ) : null}
    </div>
  );
}

function useFormat() {
  const { locale } = useLocale();
  const hours = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const day = new Intl.DateTimeFormat(locale, { day: "numeric", month: "long" });
  return {
    locale,
    hours: (seconds: number) => hours.format(seconds / 3_600),
    date: (ms: number | null | undefined) => (ms == null ? "" : day.format(new Date(ms))),
  };
}

/** The plan of this Mac's Cloud place, and what it may buy. */
export function CloudSection() {
  const format = useFormat();
  // The plan as it was when a Stripe page opened; null when nothing is awaited.
  const [waiting, setWaiting] = useState<{ readonly since: number; readonly was: string } | null>(
    null,
  );
  const quota = useQuery({
    ...orpc.compute.quota.queryOptions(),
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: waiting === null ? false : POLL_MS,
  });
  const open = useMutation(orpc.compute.openBilling.mutationOptions());
  const snapshot = quota.data == null ? null : JSON.stringify(quota.data);

  useEffect(() => {
    if (waiting === null) return;
    if (snapshot !== waiting.was || Date.now() - waiting.since > WAIT_MS) setWaiting(null);
  }, [snapshot, waiting]);

  if (quota.data == null) {
    return quota.isError ? (
      <p className="text-body-s text-error">{errorMessage(quota.error)}</p>
    ) : null;
  }
  const plan = quota.data;
  const ask = (page: ComputeBillingInput["page"]) =>
    open.mutate(
      { page, locale: format.locale === "fr" ? "fr" : "en" },
      {
        onSuccess: ({ outcome }) => {
          if (outcome === "opened") setWaiting({ since: Date.now(), was: snapshot ?? "" });
        },
      },
    );
  const outcome = open.data?.outcome;
  const problem =
    open.error !== null
      ? errorMessage(open.error)
      : outcome === undefined || outcome === "opened"
        ? null
        : billingText[outcome]();

  return (
    <div className="flex max-w-[40rem] flex-col gap-m">
      <PlanCard plan={plan} format={format} onAsk={ask} pending={open.isPending} />
      {plan.plan === "trial" || plan.plan === "ended" || plan.plan === "beta" ? (
        <FounderOffer onAsk={ask} pending={open.isPending} />
      ) : null}
      {waiting === null ? null : (
        <div className="flex flex-wrap items-center gap-s">
          <p className="text-body-s text-cte-text-muted">{m.cloud_waiting()}</p>
          <Button variant="ghost" onClick={() => setWaiting(null)}>
            {m.cloud_waiting_stop()}
          </Button>
        </div>
      )}
      {problem === null ? null : (
        <p role="alert" className="text-body-s text-error">
          {problem}
        </p>
      )}
    </div>
  );
}

type Ask = (page: ComputeBillingInput["page"]) => void;

function PlanCard({
  plan,
  format,
  onAsk,
  pending,
}: {
  plan: ComputeQuota;
  format: ReturnType<typeof useFormat>;
  onAsk: Ask;
  pending: boolean;
}) {
  const subscription = plan.subscription ?? null;
  if (plan.period === "total" && plan.limitSeconds !== null) {
    const left = Math.max(0, Math.ceil((plan.limitSeconds - plan.usedSeconds) / 60));
    const total = Math.round(plan.limitSeconds / 60);
    return (
      <div className="flex flex-col gap-xs">
        <Meter
          value={Math.min(plan.usedSeconds, plan.limitSeconds)}
          max={plan.limitSeconds}
          high={plan.limitSeconds - 1}
          aria-label={m.cloud_trial()}
        >
          <MeterLabel>{m.cloud_trial()}</MeterLabel>
          <MeterValue>
            {() => m.cloud_trial_left({ left: String(left), total: String(total) })}
          </MeterValue>
        </Meter>
        {left === 0 ? <p className="text-body-s font-medium">{m.cloud_trial_done()}</p> : null}
      </div>
    );
  }
  const limit = plan.limitSeconds ?? 0;
  const periodDone = limit > 0 && plan.usedSeconds >= limit && plan.extraSeconds <= 0;
  const status =
    subscription === null ? null : subscription.status === "ended" ? (
      <Badge>{m.cloud_ended()}</Badge>
    ) : subscription.status === "past_due" ? (
      <Badge variant="error">{m.cloud_past_due()}</Badge>
    ) : subscription.cancelAtPeriodEnd ? (
      <Badge variant="warning">{m.cloud_ends({ date: format.date(subscription.periodEnd) })}</Badge>
    ) : (
      <Badge variant="success">{m.cloud_active()}</Badge>
    );
  const paying = subscription !== null && subscription.status !== "ended";
  return (
    <div className="flex flex-col gap-s">
      {subscription === null ? null : (
        <div className="flex flex-wrap items-center gap-s">
          <span className="font-medium">{m.cloud_plan_founder()}</span>
          {status}
        </div>
      )}
      {subscription?.status === "active" && !subscription.cancelAtPeriodEnd ? (
        <p className="text-body-s text-cte-text-muted">
          {m.cloud_renews({ date: format.date(subscription.periodEnd) })}
        </p>
      ) : null}
      {subscription?.status === "active" && subscription.cancelAtPeriodEnd ? (
        <p className="text-body-s text-cte-text-muted">
          {m.cloud_ends_detail({ date: format.date(subscription.periodEnd) })}
        </p>
      ) : null}
      {subscription?.status === "past_due" ? (
        <p className="text-body-s text-cte-text-muted">{m.cloud_past_due_detail()}</p>
      ) : null}
      {subscription?.status === "ended" ? (
        <p className="text-body-s text-cte-text-muted">{m.cloud_ended_detail()}</p>
      ) : null}
      {limit > 0 ? (
        <Meter
          value={Math.min(plan.usedSeconds, limit)}
          max={limit}
          high={limit - 1}
          aria-label={m.cloud_period()}
        >
          <MeterLabel>{m.cloud_period()}</MeterLabel>
          <MeterValue>
            {() =>
              m.cloud_hours({ used: format.hours(plan.usedSeconds), limit: format.hours(limit) })
            }
          </MeterValue>
        </Meter>
      ) : null}
      {plan.extraSeconds > 0 ? (
        <p className="text-body-s text-cte-text-muted">
          {m.cloud_extra({ hours: format.hours(plan.extraSeconds) })}
        </p>
      ) : null}
      {periodDone && subscription !== null && paying ? (
        <p className="text-body-s font-medium">
          {m.cloud_period_done({ date: format.date(subscription.periodEnd) })}
        </p>
      ) : null}
      {subscription === null ? null : (
        <div className="flex flex-wrap gap-s">
          {paying ? (
            <Button
              variant={periodDone ? "primary" : "secondary"}
              isPending={pending}
              onClick={() => onAsk("topup")}
            >
              {m.cloud_topup()}
            </Button>
          ) : null}
          <Button
            variant={subscription.status === "past_due" ? "primary" : "secondary"}
            isPending={pending}
            onClick={() => onAsk("portal")}
          >
            {subscription.status === "past_due" ? m.cloud_update_card() : m.cloud_manage()}
          </Button>
        </div>
      )}
      {subscription === null ? null : (
        <p className="text-body-xs text-cte-text-muted">{m.cloud_stripe_note()}</p>
      )}
    </div>
  );
}

/** The plan a trial, an ended subscription or a beta place may take. */
function FounderOffer({ onAsk, pending }: { onAsk: Ask; pending: boolean }) {
  return (
    <div className="flex flex-col gap-s">
      <div className="flex flex-wrap items-baseline justify-between gap-s">
        <span className="font-medium">{m.cloud_founder()}</span>
        <span className="text-body-s">{m.cloud_founder_price()}</span>
      </div>
      <p className="text-body-s text-cte-text-muted">{m.cloud_founder_detail()}</p>
      <Button className="self-start" isPending={pending} onClick={() => onAsk("subscription")}>
        {m.cloud_subscribe()}
      </Button>
    </div>
  );
}
