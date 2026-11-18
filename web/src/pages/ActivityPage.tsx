/**
 * Activity: the workspace's GitHub deliveries, newest first, with cursor
 * paging. Ignored deliveries are not listed by the API, and per-notification
 * detail is not available yet, so an expanded row shows the delivery's own
 * stored summary and (masked) error text.
 */

import type { DeliveryDto } from "@contracts";
import { useState } from "react";
import { useDeliveries } from "../api/queries";
import { Shell } from "../components/Shell";
import { StatusMark } from "../components/StatusMark";
import { EmptyState, ErrorLine, LoadingRows, PageHeader } from "../components/ui";
import { describeEvent, formatTime } from "../lib/format";
import { deliveryStatus } from "../lib/status";
import { useWorkspace } from "../workspace/workspace-context";

export function ActivityPage() {
  const { workspaceId } = useWorkspace();
  const deliveries = useDeliveries(workspaceId);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const header = (
    <PageHeader kicker="02" title="Activity">
      <p className="mt-2 text-[13px] text-mu">
        GitHub events Syncro processed for your repositories, newest first. Events Syncro ignores (for example
        on unwatched branches) aren’t listed.
      </p>
    </PageHeader>
  );

  if (deliveries.isPending) {
    return (
      <Shell>
        {header}
        <LoadingRows />
      </Shell>
    );
  }
  if (deliveries.isError && !deliveries.data) {
    return (
      <Shell>
        {header}
        <ErrorLine error={deliveries.error} onRetry={() => void deliveries.refetch()} />
      </Shell>
    );
  }

  const items = deliveries.data.pages.flatMap((p) => p.items);
  if (items.length === 0) {
    return (
      <Shell>
        {header}
        <EmptyState
          title="No activity yet"
          body="Activity appears here after GitHub sends Syncro a push or pull request from a connected repository."
          steps={["Connect a repository", "Assign a Discord destination", "Push to the watched branch"]}
        />
      </Shell>
    );
  }

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Shell>
      {header}
      <div role="table" aria-label="Deliveries" className="w-full">
        <div role="rowgroup" className="hidden md:block">
          <div role="row" className="grid grid-cols-[170px_190px_1fr_130px] gap-4 border-b border-ink py-2">
            <span role="columnheader" className="label">Received</span>
            <span role="columnheader" className="label">Repository</span>
            <span role="columnheader" className="label">Event</span>
            <span role="columnheader" className="label">Status</span>
          </div>
        </div>
        <div role="rowgroup">
          {items.map((d) => (
            <DeliveryRow key={d.deliveryId} delivery={d} open={expanded.has(d.deliveryId)} onToggle={() => toggle(d.deliveryId)} />
          ))}
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between gap-4 text-[13px]">
        <span className="text-mu">{items.length} shown</span>
        {deliveries.hasNextPage ? (
          <button
            type="button"
            className="text-action"
            onClick={() => void deliveries.fetchNextPage()}
            disabled={deliveries.isFetchingNextPage}
          >
            {deliveries.isFetchingNextPage ? "Loading…" : "Load older →"}
          </button>
        ) : (
          <span className="text-mu">No older activity</span>
        )}
      </div>
      {deliveries.isFetchNextPageError ? (
        <div className="mt-3">
          <ErrorLine error={deliveries.error} onRetry={() => void deliveries.fetchNextPage()} />
        </div>
      ) : null}
    </Shell>
  );
}

function DeliveryRow({ delivery, open, onToggle }: { delivery: DeliveryDto; open: boolean; onToggle: () => void }) {
  const status = deliveryStatus(delivery.status);
  const detailsId = `delivery-${delivery.deliveryId}`;
  return (
    <div role="row" className="border-b border-ru">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={detailsId}
        className="grid w-full gap-1 py-2.75 text-left md:grid-cols-[170px_190px_1fr_130px] md:gap-4"
      >
        <span role="cell" className="order-2 font-mono text-[12px] text-mu md:order-none">
          {formatTime(delivery.receivedAt)}
        </span>
        <span role="cell" className="order-3 truncate font-mono text-[12px] text-mu md:order-none md:text-ink">
          {delivery.summary.repoFullName}
        </span>
        <span role="cell" className="order-1 font-mono text-[12px] md:order-none">
          {describeEvent(delivery.summary)}
        </span>
        <span role="cell" className="order-4 md:order-none">
          <StatusMark {...status} />
        </span>
      </button>
      {open ? (
        <dl
          id={detailsId}
          className={`mb-3 grid grid-cols-[120px_1fr] gap-x-4 gap-y-1.5 border-l-[3px] bg-sf px-4 py-3 text-[13px] ${
            delivery.status === "failed" ? "border-l-er" : "border-l-ok"
          }`}
        >
          <Detail label="Delivery ID" value={delivery.deliveryId} mono />
          <Detail label="Event" value={delivery.summary.eventType} mono />
          {delivery.summary.branch ? <Detail label="Branch" value={delivery.summary.branch} mono /> : null}
          {delivery.summary.headShortSha ? <Detail label="Head commit" value={delivery.summary.headShortSha} mono /> : null}
          {delivery.summary.commitCount !== undefined ? (
            <Detail label="Commits" value={String(delivery.summary.commitCount)} />
          ) : null}
          {delivery.summary.prNumber !== undefined ? (
            <Detail label="Pull request" value={`#${delivery.summary.prNumber}`} mono />
          ) : null}
          {delivery.summary.action ? <Detail label="Action" value={delivery.summary.action} mono /> : null}
          <Detail label="Received" value={formatTime(delivery.receivedAt)} mono />
          {delivery.processedAt ? <Detail label="Processed" value={formatTime(delivery.processedAt)} mono /> : null}
          {delivery.errorMessage ? <Detail label="Error" value={delivery.errorMessage} error /> : null}
        </dl>
      ) : null}
    </div>
  );
}

function Detail({ label, value, mono, error }: { label: string; value: string; mono?: boolean; error?: boolean }) {
  return (
    <>
      <dt className="label self-center">{label}</dt>
      <dd className={`break-all ${mono ? "font-mono text-[12px]" : ""} ${error ? "text-er" : ""}`}>{value}</dd>
    </>
  );
}
