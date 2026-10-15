import { aiProviders, aiUsageSnapshots, encrypt, projects } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentRunResult } from "../agent/runner.js";
import type { ResolvedProvider } from "./chain.js";
import { ProviderLimitError } from "./limit.js";
import {
  isQuotaWait,
  limitTextOfRun,
  markProviderLimited,
  runWithProviders,
  selectProviders,
  type ProviderSelection,
  type SelectDeps,
  type SelectInput,
} from "./select.js";

// Scelta dell'account per ogni run `claude` (design 2026-10-15 §4), contro un
// Postgres vero: le righe di ai_providers, projects e ai_usage_snapshots sono
// seminate per davvero, e le asserzioni guardano gli id dei candidati in ordine
// o le colonne di ai_providers.

vi.setConfig({ testTimeout: 60_000 });

const KEY = randomBytes(32);
// Istante fisso: tutte le date seminate sono relative a questo.
const NOW = new Date("2026-10-15T12:00:00.000Z");
const MIN = 60_000;

let testDb: TestDb;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterEach(async () => {
  // projects → ai_providers è ON DELETE SET NULL; gli snapshot cascadano.
  await testDb.db.delete(projects);
  await testDb.db.delete(aiProviders);
});

afterAll(async () => {
  await testDb.stop();
});

function deps(over: Partial<SelectDeps> = {}): SelectDeps {
  return {
    db: testDb.db,
    encryptionKey: KEY,
    backgroundWeeklyThreshold: 90,
    now: () => NOW,
    log: () => {},
    ...over,
  };
}

const interactive = (projectId: string | null = null): SelectInput => ({
  projectId,
  workClass: "interactive",
});
const background = (projectId: string | null = null): SelectInput => ({
  projectId,
  workClass: "background",
});

async function provider(
  kind: "account" | "api_key",
  pos: number,
  opts: { enabled?: boolean; limitedUntil?: Date | null; badSecret?: boolean } = {},
): Promise<string> {
  const p = pos;
  const [row] = await testDb.db
    .insert(aiProviders)
    .values({
      position: p,
      kind,
      label: `${kind}-${p}`,
      // badSecret: cifrato con un'altra chiave → decrypt fallisce.
      secretEncrypted: encrypt(`secret-${p}`, opts.badSecret ? randomBytes(32) : KEY),
      enabled: opts.enabled ?? true,
      limitedUntil: opts.limitedUntil ?? null,
    })
    .returning();
  return row!.id;
}

async function project(opts: { aiProviderId?: string | null; exclusive?: boolean } = {}): Promise<string> {
  const uniq = randomUUID().slice(0, 8);
  const [row] = await testDb.db
    .insert(projects)
    .values({
      name: `P ${uniq}`,
      slug: `p-${uniq}`,
      ingestionKey: `ingestion-${uniq}-${randomUUID()}`,
      aiProviderId: opts.aiProviderId ?? null,
      aiProviderExclusive: opts.exclusive ?? false,
    })
    .returning();
  return row!.id;
}

async function snapshot(
  providerId: string,
  opts: {
    ageMs?: number;
    weeklyPercent?: number;
    sessionResetAt?: Date | null;
    weeklyResetAt?: Date | null;
  } = {},
): Promise<void> {
  await testDb.db.insert(aiUsageSnapshots).values({
    providerId,
    capturedAt: new Date(NOW.getTime() - (opts.ageMs ?? MIN)),
    source: "deterministic",
    parseOk: true,
    sessionRemaining: { percentUsed: 10 },
    weeklyRemaining: opts.weeklyPercent === undefined ? null : { percentUsed: opts.weeklyPercent },
    sessionResetAt: opts.sessionResetAt ?? null,
    weeklyResetAt: opts.weeklyResetAt ?? null,
  });
}

async function limitedUntilOf(id: string): Promise<Date | null> {
  const [row] = await testDb.db
    .select({ limitedUntil: aiProviders.limitedUntil })
    .from(aiProviders)
    .where(eq(aiProviders.id, id));
  return row!.limitedUntil;
}

const ids = (s: ProviderSelection): string[] => s.candidates.map((c) => c.id);

// Attempt finto: l'esito per provider è deciso da una mappa id → testo del
// limite (null = riuscito). Registra gli id provati.
function scripted(outcomes: Record<string, string | null>) {
  const tried: Array<string | undefined> = [];
  const attempt = async (p: ResolvedProvider | undefined) => {
    tried.push(p?.id);
    return { providerId: p?.id, limit: p ? (outcomes[p.id] ?? null) : null };
  };
  const limitTextOf = (v: { limit: string | null }) => v.limit;
  return { tried, attempt, limitTextOf };
}

describe("selectProviders", () => {
  it("nessun provider abilitato: legacyAuth, nessun candidato", async () => {
    await provider("account", 1, { enabled: false });
    const s = await selectProviders(deps(), interactive());
    expect(s).toEqual({ candidates: [], legacyAuth: true, emptyReason: null });
  });

  it("progetto senza preferito: solo abbonamenti, in ordine di position; la chiave API esclusa", async () => {
    const b = await provider("account", 3);
    await provider("api_key", 1);
    const a = await provider("account", 2);
    const pid = await project();
    const s = await selectProviders(deps(), interactive(pid));
    expect(ids(s)).toEqual([a, b]);
    expect(s.legacyAuth).toBe(false);
    expect(s.emptyReason).toBeNull();
    // Il segreto è decifrato.
    expect(s.candidates[0]).toMatchObject({ kind: "account", secret: "secret-2" });
    // Anche senza progetto.
    expect(ids(await selectProviders(deps(), interactive(null)))).toEqual([a, b]);
  });

  it("istanza con la SOLA chiave API: la chiave è candidata (comportamento di oggi)", async () => {
    const k = await provider("api_key", 1);
    await provider("account", 2, { enabled: false });
    const s = await selectProviders(deps(), interactive(await project()));
    expect(ids(s)).toEqual([k]);
    expect(s.candidates[0]).toMatchObject({ kind: "api_key", secret: "secret-1" });
  });

  it("preferito per primo, poi gli altri abbonamenti", async () => {
    const a = await provider("account", 1);
    const b = await provider("account", 2);
    const c = await provider("account", 3);
    const pid = await project({ aiProviderId: b });
    expect(ids(await selectProviders(deps(), interactive(pid)))).toEqual([b, a, c]);
  });

  it("preferito chiave API: è il primo candidato, poi gli abbonamenti", async () => {
    const a = await provider("account", 1);
    const k = await provider("api_key", 2);
    const b = await provider("account", 3);
    const pid = await project({ aiProviderId: k });
    expect(ids(await selectProviders(deps(), interactive(pid)))).toEqual([k, a, b]);
  });

  it("«solo questo»: un solo candidato; preferito disabilitato → vuoto con exclusive_unavailable", async () => {
    await provider("account", 1);
    const b = await provider("account", 2);
    const off = await provider("account", 3, { enabled: false });
    const only = await project({ aiProviderId: b, exclusive: true });
    expect(ids(await selectProviders(deps(), interactive(only)))).toEqual([b]);

    const gone = await project({ aiProviderId: off, exclusive: true });
    expect(await selectProviders(deps(), interactive(gone))).toEqual({
      candidates: [],
      legacyAuth: false,
      emptyReason: "exclusive_unavailable",
    });
  });

  it("«solo questo» con ai_provider_id NULL (provider cancellato, ON DELETE SET NULL): si comporta come senza preferito, mai exclusive_unavailable né all_limited", async () => {
    const a = await provider("account", 1);
    const b = await provider("account", 2);
    const doomed = await provider("account", 3);
    const pid = await project({ aiProviderId: doomed, exclusive: true });
    await testDb.db.delete(aiProviders).where(eq(aiProviders.id, doomed));
    const [p] = await testDb.db.select().from(projects).where(eq(projects.id, pid));
    expect(p!.aiProviderId).toBeNull();
    expect(p!.aiProviderExclusive).toBe(true);

    const s = await selectProviders(deps(), interactive(pid));
    expect(ids(s)).toEqual([a, b]);
    expect(s.emptyReason).toBeNull();
  });

  it("preferito disabilitato senza «solo questo»: gli altri abbonamenti", async () => {
    const a = await provider("account", 1);
    const off = await provider("account", 2, { enabled: false });
    const c = await provider("account", 3);
    const pid = await project({ aiProviderId: off });
    const s = await selectProviders(deps(), interactive(pid));
    expect(ids(s)).toEqual([a, c]);
    expect(s.emptyReason).toBeNull();
  });

  it("pinnedProviderId in input: unico candidato anche se il progetto non è esclusivo; pin disabilitato → exclusive_unavailable", async () => {
    const a = await provider("account", 1);
    const b = await provider("account", 2);
    const off = await provider("account", 3, { enabled: false });
    const pid = await project({ aiProviderId: a });
    expect(
      ids(await selectProviders(deps(), { ...interactive(pid), pinnedProviderId: b })),
    ).toEqual([b]);
    expect(
      await selectProviders(deps(), { ...interactive(pid), pinnedProviderId: off }),
    ).toEqual({ candidates: [], legacyAuth: false, emptyReason: "exclusive_unavailable" });
    // pinnedProviderId null = si legge il progetto.
    expect(
      ids(await selectProviders(deps(), { ...interactive(pid), pinnedProviderId: null })),
    ).toEqual([a, b]);
  });

  it("account al limite (limited_until futuro) escluso; scaduto ammesso", async () => {
    await provider("account", 1, { limitedUntil: new Date(NOW.getTime() + 30 * MIN) });
    const expired = await provider("account", 2, { limitedUntil: new Date(NOW.getTime() - MIN) });
    const free = await provider("account", 3);
    expect(ids(await selectProviders(deps(), interactive()))).toEqual([expired, free]);
  });

  it("tutti al limite: vuoto con all_limited", async () => {
    const until = new Date(NOW.getTime() + 30 * MIN);
    await provider("account", 1, { limitedUntil: until });
    await provider("account", 2, { limitedUntil: until });
    expect(await selectProviders(deps(), interactive())).toEqual({
      candidates: [],
      legacyAuth: false,
      emptyReason: "all_limited",
    });
  });

  it("tutti gli abbonamenti al limite e una chiave API abilitata: vuoto con all_limited, la chiave NON entra (preflight D3)", async () => {
    const until = new Date(NOW.getTime() + 30 * MIN);
    await provider("account", 1, { limitedUntil: until });
    await provider("api_key", 2);
    const s = await selectProviders(deps(), interactive(await project()));
    expect(s).toEqual({ candidates: [], legacyAuth: false, emptyReason: "all_limited" });
  });

  it("background: escluso l'account con settimanale ≥ soglia da snapshot fresco; ammesso con snapshot vecchio o assente", async () => {
    const over = await provider("account", 1);
    const stale = await provider("account", 2);
    const none = await provider("account", 3);
    const under = await provider("account", 4);
    await snapshot(over, { weeklyPercent: 90 }); // = soglia: escluso
    await snapshot(stale, { weeklyPercent: 99, ageMs: 16 * MIN });
    await snapshot(under, { weeklyPercent: 89 });
    expect(ids(await selectProviders(deps(), background()))).toEqual([stale, none, under]);
  });

  it("interactive: lo stesso account oltre soglia è ammesso", async () => {
    const over = await provider("account", 1);
    await snapshot(over, { weeklyPercent: 99 });
    expect(ids(await selectProviders(deps(), interactive()))).toEqual([over]);
  });

  it("tutti oltre soglia in background: vuoto con all_over_threshold", async () => {
    const a = await provider("account", 1);
    const b = await provider("account", 2);
    await snapshot(a, { weeklyPercent: 95 });
    await snapshot(b, { weeklyPercent: 100 });
    expect(await selectProviders(deps(), background())).toEqual({
      candidates: [],
      legacyAuth: false,
      emptyReason: "all_over_threshold",
    });
  });

  it("segreto non decifrabile: scartato, gli altri restano", async () => {
    const log = vi.fn();
    const bad = await provider("account", 1, { badSecret: true });
    const good = await provider("account", 2);
    const s = await selectProviders(deps({ log }), interactive());
    expect(ids(s)).toEqual([good]);
    expect(s.emptyReason).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining(bad));
    // Il segreto non finisce mai nel log.
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret-");
  });

  it("tutti i candidati non decifrabili: vuoto con no_usable_provider (mai all_limited)", async () => {
    await provider("account", 1, { badSecret: true });
    await provider("account", 2, { badSecret: true });
    expect(await selectProviders(deps(), interactive())).toEqual({
      candidates: [],
      legacyAuth: false,
      emptyReason: "no_usable_provider",
    });
  });
});

describe("runWithProviders", () => {
  it("primo candidato riuscito: done, nessun account marcato", async () => {
    const a = await provider("account", 1);
    const b = await provider("account", 2);
    const { tried, attempt, limitTextOf } = scripted({});
    const r = await runWithProviders(deps(), interactive(), attempt, limitTextOf);
    expect(r.kind).toBe("done");
    expect(r.kind === "done" && r.provider?.id).toBe(a);
    expect(r.kind === "done" && r.value.providerId).toBe(a);
    expect(tried).toEqual([a]);
    expect(await limitedUntilOf(a)).toBeNull();
    expect(await limitedUntilOf(b)).toBeNull();
  });

  it("limite sul primo: marcato con l'ora del testo, provato il secondo, onLimited(p, 1, 2) chiamato", async () => {
    const a = await provider("account", 1);
    const b = await provider("account", 2);
    const onLimited = vi.fn();
    const { tried, attempt, limitTextOf } = scripted({
      [a]: "You've hit your session limit · resets 6pm (UTC)",
    });
    const r = await runWithProviders(deps(), interactive(), attempt, limitTextOf, { onLimited });
    expect(r.kind).toBe("done");
    expect(r.kind === "done" && r.provider?.id).toBe(b);
    expect(tried).toEqual([a, b]);
    expect(await limitedUntilOf(a)).toEqual(new Date("2026-10-15T18:00:00.000Z"));
    expect(await limitedUntilOf(b)).toBeNull();
    expect(onLimited).toHaveBeenCalledTimes(1);
    expect(onLimited).toHaveBeenCalledWith(expect.objectContaining({ id: a }), 1, 2);
  });

  it("limite senza ora nel testo: limited_until dallo snapshot (il più vicino), altrimenti now+60min", async () => {
    const a = await provider("account", 1);
    const b = await provider("account", 2);
    const c = await provider("account", 3);
    const sessionResetAt = new Date(NOW.getTime() + 2 * 60 * MIN);
    const weeklyResetAt = new Date(NOW.getTime() + 3 * 24 * 60 * MIN);
    await snapshot(a, { sessionResetAt, weeklyResetAt });
    // b: snapshot con reset già passati → inutilizzabili, si ripiega su now+60.
    await snapshot(b, { sessionResetAt: new Date(NOW.getTime() - MIN) });
    const { tried, attempt, limitTextOf } = scripted({ [a]: "rate limit", [b]: "rate limit" });
    const r = await runWithProviders(deps(), interactive(), attempt, limitTextOf);
    expect(r.kind === "done" && r.provider?.id).toBe(c);
    expect(tried).toEqual([a, b, c]);
    expect(await limitedUntilOf(a)).toEqual(sessionResetAt);
    expect(await limitedUntilOf(b)).toEqual(new Date(NOW.getTime() + 60 * MIN));
  });

  it("limite SETTIMANALE senza ora nel testo: limited_until = weekly_reset_at anche se session_reset_at è più vicino (preflight D18)", async () => {
    const a = await provider("account", 1);
    await provider("account", 2);
    const sessionResetAt = new Date(NOW.getTime() + 2 * 60 * MIN);
    const weeklyResetAt = new Date(NOW.getTime() + 3 * 24 * 60 * MIN);
    await snapshot(a, { sessionResetAt, weeklyResetAt });
    const { attempt, limitTextOf } = scripted({ [a]: "You've hit your weekly limit" });
    await runWithProviders(deps(), interactive(), attempt, limitTextOf);
    expect(await limitedUntilOf(a)).toEqual(weeklyResetAt);
  });

  it("ProviderLimitError lanciata: trattata come un risultato al limite, ora presa da agentOutput (preflight D6)", async () => {
    const a = await provider("account", 1);
    const b = await provider("account", 2);
    const tried: string[] = [];
    const r = await runWithProviders(
      deps(),
      interactive(),
      async (p) => {
        tried.push(p!.id);
        if (p!.id === a) {
          throw new ProviderLimitError("You've hit your session limit · resets 1:30pm (UTC)");
        }
        return "ok";
      },
      () => null,
    );
    expect(r).toMatchObject({ kind: "done", value: "ok", provider: { id: b } });
    expect(tried).toEqual([a, b]);
    expect(await limitedUntilOf(a)).toEqual(new Date("2026-10-15T13:30:00.000Z"));
  });

  it("eccezione non di limite: rilanciata, nessun account marcato", async () => {
    const a = await provider("account", 1);
    const b = await provider("account", 2);
    const tried: string[] = [];
    await expect(
      runWithProviders(
        deps(),
        interactive(),
        async (p) => {
          tried.push(p!.id);
          throw new Error("git clone fallito");
        },
        () => null,
      ),
    ).rejects.toThrow("git clone fallito");
    expect(tried).toEqual([a]);
    expect(await limitedUntilOf(a)).toBeNull();
    expect(await limitedUntilOf(b)).toBeNull();
  });

  it("tutti al limite durante i tentativi: unavailable all_limited_now", async () => {
    const a = await provider("account", 1);
    const b = await provider("account", 2);
    const onLimited = vi.fn();
    const { tried, attempt, limitTextOf } = scripted({ [a]: "rate limit", [b]: "rate limit" });
    const r = await runWithProviders(deps(), interactive(), attempt, limitTextOf, { onLimited });
    expect(r).toEqual({ kind: "unavailable", reason: "all_limited_now" });
    expect(tried).toEqual([a, b]);
    expect(onLimited.mock.calls.map((c) => [c[0].id, c[1], c[2]])).toEqual([
      [a, 1, 2],
      [b, 2, 2],
    ]);
    expect(await limitedUntilOf(a)).toEqual(new Date(NOW.getTime() + 60 * MIN));
    expect(await limitedUntilOf(b)).toEqual(new Date(NOW.getTime() + 60 * MIN));
    // E una selezione vuota prima ancora di provare: unavailable col motivo.
    const r2 = await runWithProviders(deps(), interactive(), attempt, limitTextOf);
    expect(r2).toEqual({ kind: "unavailable", reason: "all_limited" });
    expect(tried).toEqual([a, b]);
  });

  it("legacyAuth: un tentativo con provider undefined; finito al limite → legacy_limited col testo", async () => {
    const seen: Array<ResolvedProvider | undefined> = [];
    const ok = await runWithProviders(
      deps(),
      interactive(),
      async (p) => {
        seen.push(p);
        return "fatto";
      },
      () => null,
    );
    expect(ok).toEqual({ kind: "done", value: "fatto", provider: undefined });

    const limited = await runWithProviders(
      deps(),
      interactive(),
      async (p) => {
        seen.push(p);
        return { output: "You've hit your usage limit", exitCode: 1 } satisfies AgentRunResult;
      },
      limitTextOfRun,
    );
    expect(limited).toEqual({
      kind: "legacy_limited",
      value: { output: "You've hit your usage limit", exitCode: 1 },
      limitText: "You've hit your usage limit",
    });
    expect(seen).toEqual([undefined, undefined]);
  });

  it("legacyAuth e ProviderLimitError lanciata: legacy_limited con agentOutput come testo, senza value; un errore non di limite è rilanciato", async () => {
    const text = "You've hit your session limit · resets 6pm (UTC)";
    const limited = await runWithProviders(
      deps(),
      interactive(),
      async () => {
        throw new ProviderLimitError(text);
      },
      () => null,
    );
    expect(limited).toEqual({ kind: "legacy_limited", limitText: text });
    expect(limited.kind === "legacy_limited" && limited.value).toBeUndefined();

    await expect(
      runWithProviders(
        deps(),
        interactive(),
        async () => {
          throw new Error("git clone fallito");
        },
        () => null,
      ),
    ).rejects.toThrow("git clone fallito");
  });

  it("selectProvidersFn iniettato: usato al posto della lettura di ai_providers", async () => {
    // Nessuna riga in ai_providers: la lettura vera darebbe legacyAuth.
    const fake: ResolvedProvider = { id: randomUUID(), kind: "account", secret: "finto" };
    const selectProvidersFn = vi.fn(async () => ({
      candidates: [fake],
      legacyAuth: false,
      emptyReason: null,
    }));
    const markProviderLimitedFn = vi.fn(async () => {});
    const seen: Array<ResolvedProvider | undefined> = [];
    const d = deps({ selectProvidersFn, markProviderLimitedFn });
    const input = interactive();
    const r = await runWithProviders(
      d,
      input,
      async (p) => {
        seen.push(p);
        return "rate limit";
      },
      (v) => v,
    );
    expect(selectProvidersFn).toHaveBeenCalledWith(d, input);
    expect(seen).toEqual([fake]);
    expect(r).toEqual({ kind: "unavailable", reason: "all_limited_now" });
    expect(markProviderLimitedFn).toHaveBeenCalledWith(
      testDb.db,
      fake.id,
      new Date(NOW.getTime() + 60 * MIN),
    );
  });

  it("Review Focus #1: due runWithProviders paralleli al limite sullo stesso account → un solo limited_until, il più lontano", async () => {
    const a = await provider("account", 1);
    const b = await provider("account", 2);
    // Entrambi i run scelgono `a` prima che qualcuno lo marchi (il secondo
    // entra nel tentativo, poi il primo lo chiude). Il primo vede un reset più
    // lontano e lo scrive; il secondo, con un reset più vicino, finisce il suo
    // tentativo solo DOPO quella scrittura: scrive per ultimo, e non deve
    // accorciare il limite.
    let secondEntered!: () => void;
    const secondEnteredP = new Promise<void>((r) => (secondEntered = r));
    let firstMarked!: () => void;
    const firstMarkedP = new Promise<void>((r) => (firstMarked = r));
    const marks: string[] = [];
    const run = (text: string, second: boolean) =>
      runWithProviders(
        deps({
          markProviderLimitedFn: async (db, id, until) => {
            await markProviderLimited(db, id, until);
            marks.push(until.toISOString());
            if (!second) firstMarked();
          },
        }),
        interactive(),
        async (p) => {
          if (p!.id === a) {
            if (second) {
              secondEntered();
              await firstMarkedP;
            } else {
              await secondEnteredP;
            }
            return text;
          }
          return "ok";
        },
        (v) => (v === "ok" ? null : v),
      );
    const [r1, r2] = await Promise.all([
      run("You've hit your session limit · resets 6pm (UTC)", false),
      run("You've hit your session limit · resets 2pm (UTC)", true),
    ]);
    expect(r1).toMatchObject({ kind: "done", provider: { id: b } });
    expect(r2).toMatchObject({ kind: "done", provider: { id: b } });
    // Entrambi hanno scritto, il più vicino per ultimo.
    expect(marks).toEqual(["2026-10-15T18:00:00.000Z", "2026-10-15T14:00:00.000Z"]);
    expect(await limitedUntilOf(a)).toEqual(new Date("2026-10-15T18:00:00.000Z"));
    expect(await limitedUntilOf(b)).toBeNull();
  });
});

describe("markProviderLimited", () => {
  it("non accorcia un limite già più lontano; su un id inesistente è un no-op", async () => {
    const a = await provider("account", 1);
    const far = new Date(NOW.getTime() + 5 * 60 * MIN);
    const near = new Date(NOW.getTime() + 60 * MIN);
    await markProviderLimited(testDb.db, a, far);
    await markProviderLimited(testDb.db, a, near);
    expect(await limitedUntilOf(a)).toEqual(far);
    await expect(markProviderLimited(testDb.db, randomUUID(), far)).resolves.toBeUndefined();
  });
});

describe("limitTextOfRun e isQuotaWait", () => {
  it("limitTextOfRun: l'output solo se il run è al limite", () => {
    expect(limitTextOfRun({ output: "rate limit", exitCode: 1 })).toBe("rate limit");
    expect(limitTextOfRun({ output: "rate limit", exitCode: 0 })).toBeNull();
    expect(limitTextOfRun({ output: "boom", exitCode: 1 })).toBeNull();
  });

  it("isQuotaWait: attesa di margine contro configurazione da sistemare", () => {
    expect(isQuotaWait("all_limited")).toBe(true);
    expect(isQuotaWait("all_over_threshold")).toBe(true);
    expect(isQuotaWait("all_limited_now")).toBe(true);
    expect(isQuotaWait("exclusive_unavailable")).toBe(false);
    expect(isQuotaWait("no_usable_provider")).toBe(false);
  });
});
