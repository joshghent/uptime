import type { Monitor } from "./config.ts";

export type Event = {
  monitor: Monitor;
  event: "down" | "up";
  reason: string;
  at: number;
};

/**
 * Fires the configured ntfy and webhook targets. Notification failures are
 * returned, not thrown — a dead webhook must never stop a check run from
 * recording its result.
 */
export async function notify(e: Event, fetchImpl: typeof fetch = fetch): Promise<Error[]> {
  const { ntfy, webhook } = e.monitor.notify;
  const jobs: Promise<Response>[] = [];

  if (ntfy) {
    const down = e.event === "down";
    jobs.push(
      fetchImpl(ntfy.url, {
        method: "POST",
        headers: {
          ...ntfy.headers,
          Title: `${down ? "DOWN" : "RECOVERED"}: ${e.monitor.name}`,
          Priority: down ? "urgent" : "default",
          Tags: down ? "rotating_light" : "white_check_mark",
        },
        body: e.reason,
      }),
    );
  }

  if (webhook) {
    jobs.push(
      fetchImpl(webhook.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...webhook.headers },
        body: JSON.stringify({
          monitor: e.monitor.id,
          name: e.monitor.name,
          event: e.event,
          reason: e.reason,
          at: new Date(e.at * 1000).toISOString(),
        }),
      }),
    );
  }

  const settled = await Promise.allSettled(jobs);
  return settled.flatMap((r) => {
    if (r.status === "rejected") return [r.reason instanceof Error ? r.reason : new Error(String(r.reason))];
    if (!r.value.ok) return [new Error(`notify target returned ${r.value.status}`)];
    return [];
  });
}
