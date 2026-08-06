import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseDuration, slug } from "../src/config.ts";

const minimal = `
monitors:
  - name: My Site
    url: https://example.com
`;

function problems(yaml: string, env: Record<string, string> = {}): string[] {
  try {
    loadConfig(yaml, env);
  } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
  throw new Error("expected the config to be rejected");
}

describe("parseDuration", () => {
  it("reads the suffixes", () => {
    expect(parseDuration("500ms")).toBe(1);
    expect(parseDuration("30s")).toBe(30);
    expect(parseDuration("5m")).toBe(300);
    expect(parseDuration("24h")).toBe(86400);
    expect(parseDuration("2d")).toBe(172800);
  });

  it("treats a bare number as seconds", () => {
    expect(parseDuration(90)).toBe(90);
    expect(parseDuration("90")).toBe(90);
  });

  it("rejects nonsense", () => {
    expect(() => parseDuration("soon")).toThrow(/not a duration/);
    expect(() => parseDuration("5 weeks")).toThrow(/not a duration/);
  });
});

describe("slug", () => {
  it("makes a url-safe id from a name", () => {
    expect(slug("My Site")).toBe("my-site");
    expect(slug("API (v2)")).toBe("api-v2");
    expect(slug("  Checkout!  ")).toBe("checkout");
  });
});

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = loadConfig(minimal);
    expect(c.title).toBe("Status");
    expect(c.retainDays).toBe(7);
    const m = c.monitors[0]!;
    expect(m.id).toBe("my-site");
    expect(m.interval).toBe(60);
    expect(m.timeout).toBe(10);
    expect(m.failuresBeforeAlarm).toBe(2);
    expect(m.type).toBe("http");
    if (m.type !== "http") throw new Error("unreachable");
    expect(m.method).toBe("GET");
    expect(m.expectStatus).toBe("2xx");
  });

  it("lets defaults cascade and monitors override them", () => {
    const c = loadConfig(`
defaults:
  interval: 5m
  timeout: 3s
monitors:
  - name: A
    url: https://a.example
  - name: B
    url: https://b.example
    interval: 30s
`);
    expect(c.monitors[0]!.interval).toBe(300);
    expect(c.monitors[0]!.timeout).toBe(3);
    expect(c.monitors[1]!.interval).toBe(30);
    expect(c.monitors[1]!.timeout).toBe(3);
  });

  it("drops the consecutive-failure default when only failing_for is set", () => {
    const c = loadConfig(`
monitors:
  - name: A
    url: https://a.example
    failing_for: 5m
`);
    expect(c.monitors[0]!.failuresBeforeAlarm).toBeUndefined();
    expect(c.monitors[0]!.failingFor).toBe(300);
  });

  it("keeps both rules when both are explicit", () => {
    const c = loadConfig(`
monitors:
  - name: A
    url: https://a.example
    failing_for: 5m
    failures_before_alarm: 4
`);
    expect(c.monitors[0]!.failuresBeforeAlarm).toBe(4);
    expect(c.monitors[0]!.failingFor).toBe(300);
  });

  it("inherits global notify targets and lets a monitor override them", () => {
    const c = loadConfig(`
notify:
  ntfy: https://ntfy.sh/global
  webhook:
    url: https://hooks.example/all
    headers:
      x-key: abc
monitors:
  - name: A
    url: https://a.example
  - name: B
    url: https://b.example
    notify:
      ntfy: https://ntfy.sh/loud
`);
    expect(c.monitors[0]!.notify.ntfy).toEqual({ url: "https://ntfy.sh/global" });
    expect(c.monitors[0]!.notify.webhook).toEqual({
      url: "https://hooks.example/all",
      headers: { "x-key": "abc" },
    });
    expect(c.monitors[1]!.notify.ntfy).toEqual({ url: "https://ntfy.sh/loud" });
    // The webhook is not overridden, so the global one still applies.
    expect(c.monitors[1]!.notify.webhook?.url).toBe("https://hooks.example/all");
  });

  it("substitutes ${VAR} from the environment", () => {
    const c = loadConfig(
      `
notify:
  ntfy: \${NTFY_URL}
monitors:
  - name: A
    url: https://a.example
`,
      { NTFY_URL: "https://ntfy.sh/secret" },
    );
    expect(c.monitors[0]!.notify.ntfy?.url).toBe("https://ntfy.sh/secret");
  });

  it("names the variable when a ${VAR} is unset", () => {
    expect(problems(`
notify:
  ntfy: \${NTFY_URL}
monitors:
  - name: A
    url: https://a.example
`)).toEqual([expect.stringContaining("${NTFY_URL} is referenced but not set")]);
  });

  it("parses heartbeat monitors", () => {
    const c = loadConfig(`
monitors:
  - name: Nightly backup
    type: heartbeat
    period: 24h
    grace: 1h
    token: hunter2
`);
    const m = c.monitors[0]!;
    expect(m.id).toBe("nightly-backup");
    if (m.type !== "heartbeat") throw new Error("unreachable");
    expect(m.period).toBe(86400);
    expect(m.grace).toBe(3600);
    expect(m.token).toBe("hunter2");
  });

  it("rejects duplicate ids", () => {
    expect(() =>
      loadConfig(`
monitors:
  - name: API
    url: https://a.example
  - name: api
    url: https://b.example
`),
    ).toThrow(/duplicate monitor id "api"/);
  });

  it("rejects unknown keys, so a typo is not silently ignored", () => {
    expect(problems(`
monitors:
  - name: A
    url: https://a.example
    timout: 5s
`)).toEqual([expect.stringContaining("timout")]);
  });

  it("rejects a bad url", () => {
    expect(problems(`
monitors:
  - name: A
    url: not-a-url
`)).toEqual([expect.stringContaining("monitors.0.url")]);
  });

  it("rejects an unparseable duration with the field path", () => {
    expect(problems(`
monitors:
  - name: A
    url: https://a.example
    interval: whenever
`)).toEqual([expect.stringContaining("monitors.0.interval")]);
  });

  it("rejects an empty file and a monitor-less file", () => {
    expect(problems("")).toEqual(["the config file is empty"]);
    expect(problems("title: Nothing\nmonitors: []")).toEqual([
      expect.stringContaining("at least one monitor is required"),
    ]);
  });

  it("reports YAML syntax errors rather than throwing raw", () => {
    expect(problems("monitors:\n  - name: A\n   url: bad-indent")).toEqual([
      expect.stringContaining("YAML syntax"),
    ]);
  });

  it("accepts a status class or an explicit list", () => {
    const c = loadConfig(`
monitors:
  - name: A
    url: https://a.example
    expect_status: [200, 204]
  - name: B
    url: https://b.example
    expect_status: 3xx
`);
    const [a, b] = c.monitors;
    if (a!.type !== "http" || b!.type !== "http") throw new Error("unreachable");
    expect(a!.expectStatus).toEqual([200, 204]);
    expect(b!.expectStatus).toBe("3xx");
  });
});
