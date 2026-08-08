import type { State } from "./check.ts";
import type { Incident } from "./db.ts";
import type { Day, MonitorStatus, Status } from "./status.ts";
import tokensCss from "./tokens.css";
import appCss from "./app.css";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

/** Where "run your own" points. One place, so a fork edits one line. */
const REPO = "https://github.com/joshghent/uptime";

const LABEL: Record<State, string> = {
  up: "Operational",
  degraded: "Degraded",
  down: "Down",
  unknown: "No data",
};

function ago(seconds: number): string {
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});
const stamp = (unix: number) => `${dateFmt.format(new Date(unix * 1000))} UTC`;

/** Stroke 1.5, currentColor, inline — no icon dependency. */
function icon(state: State): string {
  const path =
    state === "up"
      ? '<path d="M20 6 9 17l-5-5"/>'
      : state === "down"
        ? '<path d="M12 8v5"/><path d="M12 16h.01"/><circle cx="12" cy="12" r="9"/>'
        : state === "degraded"
          ? '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>'
          : '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01"/><path d="M11 12h1v4h1"/>';
  return `<svg class="icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

function bar(d: Day, monitor: string): string {
  const detail =
    d.state === "none"
      ? "no data"
      : `${d.ok}/${d.ok + d.fail} checks passed${d.degraded > 0 ? `, ${d.degraded} slow` : ""}`;
  return `<span class="bar--${d.state}" title="${esc(monitor)} — ${d.day}: ${esc(detail)}"></span>`;
}

function card(m: MonitorStatus, now: number): string {
  const uptime = m.uptime === null ? "—" : `${(m.uptime * 100).toFixed(2)}%`;
  const summary =
    m.uptime === null
      ? `${m.name}: no data recorded yet`
      : `${m.name}: ${uptime} uptime over the last 90 days, currently ${LABEL[m.state].toLowerCase()}`;

  return `<article class="card">
  <div class="card__head">
    <div>
      <h2 class="card__name">${esc(m.name)}</h2>
      ${m.description ? `<p class="card__desc">${esc(m.description)}</p>` : ""}
    </div>
    <span class="status status--${m.state}">${LABEL[m.state]}</span>
  </div>
  ${
    m.incident
      ? `<p class="card__error">Down since ${stamp(m.incident.started_at)} — ${esc(m.incident.reason)}</p>`
      : m.state === "degraded" && m.lastError
        ? `<p class="card__error">${esc(m.lastError)}</p>`
        : ""
  }
  <div class="bars" role="img" aria-label="${esc(summary)}">${m.days.map((d) => bar(d, m.name)).join("")}</div>
  <div class="bars__scale">
    <span><span class="wide">90</span><span class="narrow">30</span> days ago</span>
    <span class="tt-numeric">${uptime} uptime</span>
    <span>Today</span>
  </div>
  <div class="card__foot">
    <span>${m.type === "heartbeat" ? "Heartbeat" : "HTTP"}</span>
    <span>${m.lastCheck === null ? "never checked" : `checked ${ago(now - m.lastCheck)}`}</span>
  </div>
</article>`;
}

function banner(s: Status): string {
  const broken = s.monitors.filter((m) => m.state === "down");
  const wobbly = s.monitors.filter((m) => m.state === "degraded");
  const names = (list: MonitorStatus[]) => list.map((m) => esc(m.name)).join(", ");

  const [title, detail] =
    s.overall === "down"
      ? [
          broken.length === s.monitors.length ? "All systems down" : "Some systems are down",
          `Affected: ${names(broken)}${wobbly.length ? `. Degraded: ${names(wobbly)}` : ""}`,
        ]
      : s.overall === "degraded"
        ? ["Degraded performance", `Affected: ${names(wobbly)}`]
        : s.overall === "up"
          ? ["All systems operational", `${s.monitors.length} monitor${s.monitors.length === 1 ? "" : "s"} checked continuously`]
          : ["Waiting for the first check", "No results have been recorded yet"];

  return `<section class="banner banner--${s.overall}">
  <span class="banner__icon">${icon(s.overall)}</span>
  <div>
    <p class="banner__title">${title}</p>
    <p class="banner__detail">${detail}</p>
  </div>
</section>`;
}

function incidentRow(i: Incident, names: Map<string, string>): string {
  const duration = i.resolved_at === null ? "ongoing" : `lasted ${ago(i.resolved_at - i.started_at).replace(" ago", "")}`;
  return `<li class="incident">
  <span class="incident__name">${esc(names.get(i.monitor) ?? i.monitor)}</span>
  <span class="incident__when">${stamp(i.started_at)} · ${duration}</span>
  <span class="incident__reason">${esc(i.reason)}</span>
</li>`;
}

export function renderPage(s: Status): string {
  const names = new Map(s.monitors.map((m) => [m.id, m.name]));
  const title = esc(s.title);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>${title}</title>
${s.description ? `<meta name="description" content="${esc(s.description)}">` : ""}
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ctext y='19' font-size='20'%3E%E2%9A%A1%3C/text%3E%3C/svg%3E">
<style>${tokensCss}${appCss}</style>
</head>
<body>
<a class="skip" href="#monitors">Skip to status</a>
<header class="site">
  <div class="tt-container site__inner">
    <a class="tt-mark" href="${s.link ? esc(s.link) : "/"}"><span class="tt-mark__glyph">⚡︎</span>${title}</a>
    <span class="tt-muted tt-numeric">Updated ${stamp(s.generatedAt)}</span>
  </div>
</header>
<main class="tt-container">
  ${s.description ? `<p class="lede tt-muted">${esc(s.description)}</p>` : ""}
  ${banner(s)}
  <div class="monitors" id="monitors">${s.monitors.map((m) => card(m, s.generatedAt)).join("\n")}</div>

  <section class="section">
    <h2>Incident history</h2>
    ${
      s.incidents.length === 0
        ? `<p class="empty">No incidents in the last ${s.windowDays} days.</p>`
        : `<ul class="incidents">${s.incidents.map((i) => incidentRow(i, names)).join("\n")}</ul>`
    }
  </section>

  <section class="section">
    <h2>Run your own</h2>
    <div class="card cta">
      <p>This page is <a href="${REPO}">joshghent/uptime</a>, an open-source status
      page that runs on Cloudflare Workers and D1. Monitors live in one YAML file,
      checked by a cron, rendered server-side. Free on Cloudflare's free tier for a
      handful of monitors.</p>
      <p class="tt-muted"><a href="${REPO}#quick-start">Set one up</a> · <a href="${REPO}">Source on GitHub</a> · <a href="/llms.txt">llms.txt</a> for agents</p>
    </div>
  </section>

  <footer class="foot">
    <div class="key">
      <span><i style="background:var(--tt-color-success)"></i> Operational</span>
      <span><i style="background:var(--tt-color-warning)"></i> Degraded</span>
      <span><i style="background:var(--tt-color-danger)"></i> Down</span>
      <span><i style="background:var(--tt-color-bg-emphasis)"></i> No data</span>
    </div>
    <span>Last ${s.windowDays} days · <a href="/api/status">JSON</a> · <a href="/llms.txt">llms.txt</a> · <a href="${REPO}">Source</a></span>
  </footer>
</main>
</body>
</html>`;
}
