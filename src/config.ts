import { parse as parseYaml } from "yaml";
import { z } from "zod";

/** `30s` `5m` `24h` `2d`, or a bare number meaning seconds. Returns seconds. */
export function parseDuration(input: string | number): number {
  if (typeof input === "number") return Math.round(input);
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/.exec(input);
  if (!m) throw new Error(`not a duration: ${JSON.stringify(input)}`);
  const n = Number(m[1]);
  const mult = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 }[m[2] ?? "s"]!;
  return Math.round(n * mult);
}

export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const duration = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    try {
      return parseDuration(v);
    } catch (e) {
      ctx.addIssue({ code: "custom", message: (e as Error).message });
      return z.NEVER;
    }
  });

/** `200`, `[200, 204]`, or a class like `2xx`. */
const expectStatus = z.union([
  z.number().int(),
  z.array(z.number().int()).min(1),
  z.string().regex(/^[1-5]xx$/, "status class must be one of 1xx…5xx"),
]);

const target = z.union([
  z.string().url(),
  z.strictObject({
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
]);

const notify = z
  .strictObject({
    ntfy: target.optional(),
    webhook: target.optional(),
  })
  .optional();

const shared = {
  interval: duration.optional(),
  timeout: duration.optional(),
  /** Alarm after this many consecutive failures. */
  failures_before_alarm: z.number().int().positive().optional(),
  /** Alarm when the current failure streak has lasted at least this long. */
  failing_for: duration.optional(),
  /** Responses slower than this count as degraded (yellow), not down. */
  degraded_ms: z.number().int().positive().optional(),
  notify,
};

const httpMonitor = z.strictObject({
  name: z.string().min(1),
  id: z.string().regex(/^[a-z0-9-]+$/, "id must be lowercase a-z, 0-9 and -").optional(),
  description: z.string().optional(),
  type: z.literal("http").optional(),
  url: z.string().url(),
  method: z.string().default("GET"),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  expect_status: expectStatus.optional(),
  /** Substring the response body must contain. */
  expect_body: z.string().optional(),
  ...shared,
});

const heartbeatMonitor = z.strictObject({
  name: z.string().min(1),
  id: z.string().regex(/^[a-z0-9-]+$/, "id must be lowercase a-z, 0-9 and -").optional(),
  description: z.string().optional(),
  type: z.literal("heartbeat"),
  /** How often the job is expected to ping. */
  period: duration,
  /** Extra slack on top of `period` before it counts as missed. */
  grace: duration.optional(),
  /** When set, the ping must present it as ?token= or Authorization: Bearer. */
  token: z.string().optional(),
  ...shared,
});

const defaults = z.strictObject({
  interval: duration.optional(),
  timeout: duration.optional(),
  expect_status: expectStatus.optional(),
  failures_before_alarm: z.number().int().positive().optional(),
  failing_for: duration.optional(),
  degraded_ms: z.number().int().positive().optional(),
});

export const configSchema = z.strictObject({
  title: z.string().default("Status"),
  description: z.string().optional(),
  /** Link on the header back to your product. */
  link: z.string().url().optional(),
  /** Days of raw samples to keep. The 90-day view uses daily rollups. */
  retain_days: z.number().int().positive().default(7),
  defaults: defaults.default({}),
  notify,
  monitors: z
    .array(
      // The discriminator is matched before defaults are applied, so `type`
      // has to exist by the time the union sees it. HTTP is the common case
      // and stays optional in the YAML.
      z.preprocess(
        (v) => (v && typeof v === "object" && !("type" in v) ? { ...v, type: "http" } : v),
        z.discriminatedUnion("type", [httpMonitor.extend({ type: z.literal("http") }), heartbeatMonitor]),
      ),
    )
    .min(1, "at least one monitor is required"),
});

export type RawConfig = z.infer<typeof configSchema>;
export type Notify = { url: string; headers?: Record<string, string> };
export type NotifyTargets = { ntfy?: Notify; webhook?: Notify };

export type Monitor = {
  id: string;
  name: string;
  description?: string;
  interval: number;
  timeout: number;
  /** Undefined when only `failing_for` is configured. */
  failuresBeforeAlarm?: number;
  failingFor?: number;
  degradedMs?: number;
  notify: NotifyTargets;
} & (
  | {
      type: "http";
      url: string;
      method: string;
      headers?: Record<string, string>;
      body?: string;
      expectStatus: number[] | string;
      expectBody?: string;
    }
  | { type: "heartbeat"; period: number; grace: number; token?: string }
);

export type Config = {
  title: string;
  description?: string;
  link?: string;
  retainDays: number;
  monitors: Monitor[];
};

const DEFAULTS = {
  interval: 60,
  timeout: 10,
  expect_status: "2xx" as const,
  failures_before_alarm: 2,
};

function normaliseTarget(t: z.infer<typeof target> | undefined): Notify | undefined {
  if (!t) return undefined;
  return typeof t === "string" ? { url: t } : { url: t.url, headers: t.headers };
}

/**
 * Replace `${VAR}` in every string with the matching env value. Runs after the
 * YAML parse so a secret containing `:` or `#` can't corrupt the document.
 */
function interpolate<T>(value: T, env: Record<string, unknown>, missing: Set<string>): T {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
      const v = env[name];
      if (typeof v !== "string") {
        missing.add(name);
        return "";
      }
      return v;
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, env, missing)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, interpolate(v, env, missing)]),
    ) as T;
  }
  return value;
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`invalid status config:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/**
 * Parse and validate the YAML config. Throws {@link ConfigError} with one
 * human-readable line per problem — this is what `pnpm lint:config` prints.
 */
export function loadConfig(source: string, env: Record<string, unknown> = {}): Config {
  let doc: unknown;
  try {
    doc = parseYaml(source);
  } catch (e) {
    throw new ConfigError([`YAML syntax: ${(e as Error).message}`]);
  }
  if (doc === null || doc === undefined) throw new ConfigError(["the config file is empty"]);

  const missing = new Set<string>();
  const interpolated = interpolate(doc, env, missing);

  // Before the schema runs: an unset variable collapses to "", and "Invalid
  // URL" is a much worse error than naming the secret you forgot to set.
  if (missing.size > 0) {
    throw new ConfigError(
      [...missing].map((n) => `\${${n}} is referenced but not set — add it with \`wrangler secret put ${n}\``),
    );
  }

  const parsed = configSchema.safeParse(interpolated);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }

  const c = parsed.data;
  const globalNotify: NotifyTargets = {
    ntfy: normaliseTarget(c.notify?.ntfy),
    webhook: normaliseTarget(c.notify?.webhook),
  };

  const ids = new Set<string>();
  const monitors = c.monitors.map((m) => {
    const id = m.id ?? slug(m.name);
    if (!id) throw new ConfigError([`monitor "${m.name}": name produces an empty id, set \`id:\` explicitly`]);
    if (ids.has(id)) throw new ConfigError([`duplicate monitor id "${id}" — ids must be unique`]);
    ids.add(id);

    const own: NotifyTargets = {
      ntfy: normaliseTarget(m.notify?.ntfy) ?? globalNotify.ntfy,
      webhook: normaliseTarget(m.notify?.webhook) ?? globalNotify.webhook,
    };
    // Setting only `failing_for` means "alarm on duration", so the consecutive
    // -failure default must not fire first and pre-empt it. An explicit
    // `failures_before_alarm` alongside it keeps both rules, whichever trips first.
    const failingFor = m.failing_for ?? c.defaults.failing_for;
    const failures = m.failures_before_alarm ?? c.defaults.failures_before_alarm;
    const base = {
      id,
      name: m.name,
      description: m.description,
      interval: m.interval ?? c.defaults.interval ?? DEFAULTS.interval,
      timeout: m.timeout ?? c.defaults.timeout ?? DEFAULTS.timeout,
      failuresBeforeAlarm: failures ?? (failingFor ? undefined : DEFAULTS.failures_before_alarm),
      failingFor,
      degradedMs: m.degraded_ms ?? c.defaults.degraded_ms,
      notify: own,
    };

    if (m.type === "heartbeat") {
      return { ...base, type: "heartbeat" as const, period: m.period, grace: m.grace ?? 0, token: m.token };
    }
    const expect = m.expect_status ?? c.defaults.expect_status ?? DEFAULTS.expect_status;
    return {
      ...base,
      type: "http" as const,
      url: m.url,
      method: m.method.toUpperCase(),
      headers: m.headers,
      body: m.body,
      expectStatus: typeof expect === "number" ? [expect] : expect,
      expectBody: m.expect_body,
    };
  });

  return {
    title: c.title,
    description: c.description,
    link: c.link,
    retainDays: c.retain_days,
    monitors,
  };
}
