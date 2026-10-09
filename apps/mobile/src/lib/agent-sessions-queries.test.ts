import { ApiError } from "@stubwise/api-client";
import { aiJobStatusSchema, UNKNOWN, type AiJobStatus, type Reader } from "@stubwise/shared";
import { QueryClient } from "@tanstack/react-query";
import { agentSessionKeys } from "./query-keys";
import {
  agentSessionEventsQueryOptions,
  agentSessionQueryOptions,
  agentSessionRefetchInterval,
  agentSessionsLookupQueryOptions,
  agentSessionsQueryOptions,
  shouldPollAgentSessionLookup,
} from "./agent-sessions-queries";
import { describeAgentSessionError } from "./agent-session-errors";

const client = {
  agentSessions: { list: jest.fn(), get: jest.fn(), events: jest.fn() },
} as never;
const unavailable = new ApiError(404, "Not Found", undefined);
const gone = new ApiError(404, "Not Found", "not_found");

describe("agentSessionKeys", () => {
  test("forme", () => {
    expect(agentSessionKeys.all).toEqual(["agent-sessions"]);
    expect(agentSessionKeys.list()).toEqual(["agent-sessions", "list", {}]);
    expect(agentSessionKeys.list({ ticketId: "t" })).toEqual(["agent-sessions", "list", { ticketId: "t" }]);
    expect(agentSessionKeys.detail("a")).toEqual(["agent-sessions", "detail", "a"]);
    expect(agentSessionKeys.events("a")).toEqual(["agent-sessions", "events", "a"]);
  });
});

describe("lista", () => {
  const retry = agentSessionsQueryOptions(client).retry as (n: number, e: Error) => boolean;
  const interval = agentSessionsQueryOptions(client).refetchInterval as (q: unknown) => number | false;
  test("nessun retry e nessun polling su un 404 senza code", () => {
    expect(retry(0, unavailable)).toBe(false);
    expect(interval({ state: { error: unavailable } })).toBe(false);
  });
  test("un 404 col code è un errore vero: si riprova e si fa polling", () => {
    expect(retry(0, gone)).toBe(true);
    expect(retry(3, gone)).toBe(false);
    expect(interval({ state: { error: gone } })).toBe(5_000);
    expect(interval({ state: { error: null } })).toBe(5_000);
  });
  test("polling spento quando la schermata non è a fuoco", () => {
    const off = agentSessionsQueryOptions(client, undefined, { focused: false }).refetchInterval as (q: unknown) => number | false;
    expect(off({ state: { error: null } })).toBe(false);
  });
  test("chiama list con i filtri", async () => {
    (client as unknown as { agentSessions: { list: jest.Mock } }).agentSessions.list.mockResolvedValue({ live: [], recent: [] });
    await new QueryClient().fetchQuery(agentSessionsQueryOptions(client, { projectId: "p" }) as never);
    expect((client as unknown as { agentSessions: { list: jest.Mock } }).agentSessions.list).toHaveBeenCalledWith({ projectId: "p" });
  });
});

describe("dettaglio", () => {
  test("nessun retry su un 4xx", () => {
    const retry = agentSessionQueryOptions(client, "a").retry as (n: number, e: Error) => boolean;
    expect(retry(0, gone)).toBe(false);
    expect(retry(0, new ApiError(403, "x", "forbidden"))).toBe(false);
    expect(retry(0, new ApiError(500, "x", undefined))).toBe(true);
    expect(retry(3, new ApiError(500, "x", undefined))).toBe(false);
  });
  test("polling 10 s solo se ended e senza errore", () => {
    expect(agentSessionRefetchInterval({ state: "ended" }, null)).toBe(10_000);
    expect(agentSessionRefetchInterval({ state: "ended" }, gone)).toBe(false);
    expect(agentSessionRefetchInterval({ state: "working" }, null)).toBe(false);
    expect(agentSessionRefetchInterval(undefined, null)).toBe(false);
  });
});

describe("prima pagina di eventi", () => {
  test("mai rinfrescata da sola, scartata allo smontaggio", () => {
    const o = agentSessionEventsQueryOptions(client, "a");
    expect(o.queryKey).toEqual(["agent-sessions", "events", "a"]);
    expect(o.staleTime).toBe(Infinity);
    expect(o.gcTime).toBe(0);
  });
});

describe("lookup del ticket", () => {
  test("la revisione sta nella chiave", () => {
    const a = agentSessionsLookupQueryOptions(client, { aiJobId: "j" }, "fixing").queryKey;
    const b = agentSessionsLookupQueryOptions(client, { aiJobId: "j" }, "failed").queryKey;
    expect(a).not.toEqual(b);
    expect(a[0]).toBe("agent-sessions");
  });
  test("polling solo con job non terminale, nessuna sessione e schermata a fuoco", () => {
    expect(shouldPollAgentSessionLookup({ jobStatus: "fixing", found: false, focused: true })).toBe(true);
    expect(shouldPollAgentSessionLookup({ jobStatus: "queued", found: false, focused: true })).toBe(true);
    expect(shouldPollAgentSessionLookup({ jobStatus: "fixing", found: true, focused: true })).toBe(false);
    expect(shouldPollAgentSessionLookup({ jobStatus: "fixing", found: false, focused: false })).toBe(false);
    expect(shouldPollAgentSessionLookup({ jobStatus: "failed", found: false, focused: true })).toBe(false);
    expect(shouldPollAgentSessionLookup({ jobStatus: "pr_merged", found: false, focused: true })).toBe(false);
    expect(shouldPollAgentSessionLookup({ jobStatus: undefined, found: false, focused: true })).toBe(false);
  });
  test("ogni stato del job ha una decisione; uno ignoto (server più nuovo) continua a cercare", () => {
    const terminal = aiJobStatusSchema.options.filter(
      (status) => !shouldPollAgentSessionLookup({ jobStatus: status, found: false, focused: true }),
    );
    expect(terminal.sort()).toEqual(["failed", "pr_closed", "pr_merged", "pr_opened", "skipped"]);
    expect(shouldPollAgentSessionLookup({ jobStatus: UNKNOWN, found: false, focused: true })).toBe(true);
    // @ts-expect-error uno stato inventato non è un AiJobStatus: il tipo lo rifiuta
    shouldPollAgentSessionLookup({ jobStatus: "fixingg", found: false, focused: true });
  });
  test("le opzioni pollano solo quando il predicato è vero, leggendo i dati", () => {
    const poll = (rev: Reader<AiJobStatus> | undefined, focused: boolean, data: unknown) =>
      (agentSessionsLookupQueryOptions(client, {}, rev, { focused }).refetchInterval as (q: unknown) => number | false)({
        state: { data },
      });
    const none = { live: [], recent: [] };
    const some = { live: [{ id: "s" }], recent: [] };
    expect(poll("fixing", true, undefined)).toBe(10_000);
    expect(poll("fixing", true, none)).toBe(10_000);
    expect(poll("fixing", true, some)).toBe(false);
    expect(poll("fixing", false, none)).toBe(false);
    expect(poll("failed", true, none)).toBe(false);
  });
});

describe("describeAgentSessionError", () => {
  const t = (k: string) => k;
  const e = (status: number, code?: string) => new ApiError(status, "m", code);
  test.each([
    [e(409, "session_ended"), "mobile.agents.errors.session_ended"],
    [e(409, "not_interactive"), "mobile.agents.errors.not_interactive"],
    [e(409, "interrupt_unsupported"), "mobile.agents.errors.interrupt_unsupported"],
    [e(403, "forbidden"), "mobile.agents.errors.forbidden"],
    [e(404, "not_found"), "mobile.agents.errors.not_found"],
    [e(404), "mobile.agents.errors.unavailable"],
    [e(0), "mobile.agents.errors.network"],
    [new Error("x"), "mobile.agents.errors.network"],
    [e(500), "mobile.agents.errors.generic"],
  ])("%#", (err, key) => {
    expect(describeAgentSessionError(err, t as never)).toBe(key);
  });
});
