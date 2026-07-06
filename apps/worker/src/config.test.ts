import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadWorkerConfig } from "./config.js";

const VALID = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/stubwise",
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
};

describe("loadWorkerConfig", () => {
  it("carica una configurazione valida con i default", () => {
    const config = loadWorkerConfig(VALID);
    expect(config.databaseUrl).toBe(VALID.DATABASE_URL);
    expect(config.encryptionKey).toBeInstanceOf(Buffer);
    expect(config.encryptionKey.toString("base64")).toBe(VALID.ENCRYPTION_KEY);
    expect(config.mirrorsDir).toBe("/var/stubwise/mirrors");
    expect(config.concurrency).toBe(2);
    // Pool di connessioni Postgres: default 10.
    expect(config.databasePoolMax).toBe(10);
    expect(config.staleAfterMinutes).toBe(150);
    // Fix in due fasi: default opus/sonnet, attivo, plan timeout 10'.
    expect(config.fixPlanModel).toBe("opus");
    expect(config.fixExecuteModel).toBe("sonnet");
    expect(config.fixTwoPhase).toBe(true);
    expect(config.fixPlanTimeoutMs).toBe(600_000);
    // Self-repair: default 2 RE-tentativi, timeout test 5'.
    expect(config.selfRepairMaxAttempts).toBe(2);
    expect(config.selfRepairTestTimeoutMs).toBe(300_000);
    // Install delle dipendenze nel worktree: timeout default 10'.
    expect(config.installTimeoutMs).toBe(600_000);
    // PUBLIC_URL non impostato: default stringa vuota (il link al ticket nelle
    // notifiche è il solo path).
    expect(config.publicUrl).toBe("");
    // Poller dell'usage residuo: default 5 minuti.
    expect(config.usagePollMinutes).toBe(5);
    // Tester delle credenziali: default 5 secondi.
    expect(config.credentialTestPollSeconds).toBe(5);
    // Timeout per-chiamata della generazione Docs: default 8'.
    expect(config.docAgentTimeoutMs).toBe(480_000);
    // Poller di auto-aggiornamento Docs: default 60 secondi.
    expect(config.docsAutoUpdatePollSeconds).toBe(60);
    // Rigenerazione mirata: default 10 pagine per push.
    expect(config.docsAutoUpdateMaxPages).toBe(10);
    // Creazione incrementale (Fase 3): default 5 pagine nuove per push.
    expect(config.docsAutoUpdateMaxNewPages).toBe(5);
    // Poller PR Review: default 60 secondi, sonnet, 50 turni, timeout 15'.
    expect(config.prReviewPollSeconds).toBe(60);
    expect(config.prReviewModel).toBe("sonnet");
    expect(config.prReviewMaxTurns).toBe(50);
    expect(config.prReviewTimeoutMs).toBe(900_000);
    // Resume poller dei limiti: default 5', soglia 95%, cooldown 60'.
    expect(config.limitResumePollMinutes).toBe(5);
    expect(config.limitResumeHeadroomPercent).toBe(95);
    expect(config.limitResumeCooldownMs).toBe(3_600_000);
  });

  it("rispetta LIMIT_RESUME_POLL_MINUTES esplicito e 0 = disabilitato", () => {
    expect(
      loadWorkerConfig({ ...VALID, LIMIT_RESUME_POLL_MINUTES: "10" }).limitResumePollMinutes,
    ).toBe(10);
    expect(
      loadWorkerConfig({ ...VALID, LIMIT_RESUME_POLL_MINUTES: "0" }).limitResumePollMinutes,
    ).toBe(0);
    // Vuoto (es. da .env.example) usa il default 5.
    expect(
      loadWorkerConfig({ ...VALID, LIMIT_RESUME_POLL_MINUTES: "" }).limitResumePollMinutes,
    ).toBe(5);
    expect(() => loadWorkerConfig({ ...VALID, LIMIT_RESUME_POLL_MINUTES: "-1" })).toThrow(
      /LIMIT_RESUME_POLL_MINUTES/,
    );
  });

  it("rispetta headroom e cooldown del resume poller (minuti → ms) e rifiuta i fuori range", () => {
    const config = loadWorkerConfig({
      ...VALID,
      LIMIT_RESUME_HEADROOM_PERCENT: "80",
      LIMIT_RESUME_API_KEY_COOLDOWN_MINUTES: "30",
    });
    expect(config.limitResumeHeadroomPercent).toBe(80);
    expect(config.limitResumeCooldownMs).toBe(1_800_000);
    // Vuoti (es. da .env.example) usano i default.
    const defaults = loadWorkerConfig({
      ...VALID,
      LIMIT_RESUME_HEADROOM_PERCENT: "",
      LIMIT_RESUME_API_KEY_COOLDOWN_MINUTES: "",
    });
    expect(defaults.limitResumeHeadroomPercent).toBe(95);
    expect(defaults.limitResumeCooldownMs).toBe(3_600_000);
    expect(() => loadWorkerConfig({ ...VALID, LIMIT_RESUME_HEADROOM_PERCENT: "0" })).toThrow(
      /LIMIT_RESUME_HEADROOM_PERCENT/,
    );
    expect(() => loadWorkerConfig({ ...VALID, LIMIT_RESUME_HEADROOM_PERCENT: "101" })).toThrow(
      /LIMIT_RESUME_HEADROOM_PERCENT/,
    );
    expect(() =>
      loadWorkerConfig({ ...VALID, LIMIT_RESUME_API_KEY_COOLDOWN_MINUTES: "0" }),
    ).toThrow(/LIMIT_RESUME_API_KEY_COOLDOWN_MINUTES/);
  });

  it("rispetta PR_REVIEW_POLL_SECONDS esplicito e 0 = disabilitato", () => {
    expect(loadWorkerConfig({ ...VALID, PR_REVIEW_POLL_SECONDS: "30" }).prReviewPollSeconds).toBe(
      30,
    );
    expect(loadWorkerConfig({ ...VALID, PR_REVIEW_POLL_SECONDS: "0" }).prReviewPollSeconds).toBe(0);
    // Vuoto (es. da .env.example) usa il default 60.
    expect(loadWorkerConfig({ ...VALID, PR_REVIEW_POLL_SECONDS: "" }).prReviewPollSeconds).toBe(60);
  });

  it("rispetta modello, turni e timeout della PR Review (minuti → ms)", () => {
    const config = loadWorkerConfig({
      ...VALID,
      PR_REVIEW_MODEL: "haiku",
      PR_REVIEW_MAX_TURNS: "20",
      PR_REVIEW_TIMEOUT_MINUTES: "10",
    });
    expect(config.prReviewModel).toBe("haiku");
    expect(config.prReviewMaxTurns).toBe(20);
    expect(config.prReviewTimeoutMs).toBe(600_000);
    // Vuoti (es. da .env.example) usano i default.
    const defaults = loadWorkerConfig({
      ...VALID,
      PR_REVIEW_MODEL: "",
      PR_REVIEW_MAX_TURNS: "",
      PR_REVIEW_TIMEOUT_MINUTES: "",
    });
    expect(defaults.prReviewModel).toBe("sonnet");
    expect(defaults.prReviewMaxTurns).toBe(50);
    expect(defaults.prReviewTimeoutMs).toBe(900_000);
  });

  it("rifiuta PR_REVIEW_MAX_TURNS e PR_REVIEW_TIMEOUT_MINUTES fuori range", () => {
    expect(() => loadWorkerConfig({ ...VALID, PR_REVIEW_MAX_TURNS: "0" })).toThrow(
      /PR_REVIEW_MAX_TURNS/,
    );
    expect(() => loadWorkerConfig({ ...VALID, PR_REVIEW_TIMEOUT_MINUTES: "0" })).toThrow(
      /PR_REVIEW_TIMEOUT_MINUTES/,
    );
    expect(() => loadWorkerConfig({ ...VALID, PR_REVIEW_POLL_SECONDS: "-1" })).toThrow(
      /PR_REVIEW_POLL_SECONDS/,
    );
  });

  it("rispetta DOCS_AUTOUPDATE_POLL_SECONDS esplicito e 0 = disabilitato", () => {
    expect(
      loadWorkerConfig({ ...VALID, DOCS_AUTOUPDATE_POLL_SECONDS: "30" }).docsAutoUpdatePollSeconds,
    ).toBe(30);
    expect(
      loadWorkerConfig({ ...VALID, DOCS_AUTOUPDATE_POLL_SECONDS: "0" }).docsAutoUpdatePollSeconds,
    ).toBe(0);
    // Vuoto (es. da .env.example) usa il default 60.
    expect(
      loadWorkerConfig({ ...VALID, DOCS_AUTOUPDATE_POLL_SECONDS: "" }).docsAutoUpdatePollSeconds,
    ).toBe(60);
  });

  it("rispetta DOCS_AUTOUPDATE_MAX_PAGES esplicito e 0 = disabilita la rigenerazione", () => {
    expect(
      loadWorkerConfig({ ...VALID, DOCS_AUTOUPDATE_MAX_PAGES: "5" }).docsAutoUpdateMaxPages,
    ).toBe(5);
    expect(
      loadWorkerConfig({ ...VALID, DOCS_AUTOUPDATE_MAX_PAGES: "0" }).docsAutoUpdateMaxPages,
    ).toBe(0);
    // Vuoto (es. da .env.example) usa il default 10.
    expect(
      loadWorkerConfig({ ...VALID, DOCS_AUTOUPDATE_MAX_PAGES: "" }).docsAutoUpdateMaxPages,
    ).toBe(10);
  });

  it("rispetta DOCS_AUTOUPDATE_MAX_NEW_PAGES esplicito e 0 = disabilita la creazione incrementale", () => {
    expect(
      loadWorkerConfig({ ...VALID, DOCS_AUTOUPDATE_MAX_NEW_PAGES: "3" }).docsAutoUpdateMaxNewPages,
    ).toBe(3);
    expect(
      loadWorkerConfig({ ...VALID, DOCS_AUTOUPDATE_MAX_NEW_PAGES: "0" }).docsAutoUpdateMaxNewPages,
    ).toBe(0);
    // Vuoto (es. da .env.example) usa il default 5.
    expect(
      loadWorkerConfig({ ...VALID, DOCS_AUTOUPDATE_MAX_NEW_PAGES: "" }).docsAutoUpdateMaxNewPages,
    ).toBe(5);
  });

  it("rispetta DOC_AGENT_TIMEOUT_MS esplicito e rifiuta valori non positivi", () => {
    expect(loadWorkerConfig({ ...VALID, DOC_AGENT_TIMEOUT_MS: "120000" }).docAgentTimeoutMs).toBe(
      120_000,
    );
    // Vuoto (es. da .env.example) usa il default 8'.
    expect(loadWorkerConfig({ ...VALID, DOC_AGENT_TIMEOUT_MS: "" }).docAgentTimeoutMs).toBe(480_000);
    expect(() => loadWorkerConfig({ ...VALID, DOC_AGENT_TIMEOUT_MS: "0" })).toThrow(
      /DOC_AGENT_TIMEOUT_MS/,
    );
    expect(() => loadWorkerConfig({ ...VALID, DOC_AGENT_TIMEOUT_MS: "-1" })).toThrow(
      /DOC_AGENT_TIMEOUT_MS/,
    );
  });

  it("rispetta USAGE_POLL_MINUTES esplicito e 0 = disabilitato", () => {
    expect(loadWorkerConfig({ ...VALID, USAGE_POLL_MINUTES: "15" }).usagePollMinutes).toBe(15);
    expect(loadWorkerConfig({ ...VALID, USAGE_POLL_MINUTES: "0" }).usagePollMinutes).toBe(0);
    // Vuoto (es. da .env.example) usa il default 5.
    expect(loadWorkerConfig({ ...VALID, USAGE_POLL_MINUTES: "" }).usagePollMinutes).toBe(5);
  });

  it("rispetta CREDENTIAL_TEST_POLL_SECONDS esplicito e 0 = disabilitato", () => {
    expect(
      loadWorkerConfig({ ...VALID, CREDENTIAL_TEST_POLL_SECONDS: "10" }).credentialTestPollSeconds,
    ).toBe(10);
    expect(
      loadWorkerConfig({ ...VALID, CREDENTIAL_TEST_POLL_SECONDS: "0" }).credentialTestPollSeconds,
    ).toBe(0);
    // Vuoto (es. da .env.example) usa il default 5.
    expect(
      loadWorkerConfig({ ...VALID, CREDENTIAL_TEST_POLL_SECONDS: "" }).credentialTestPollSeconds,
    ).toBe(5);
  });

  it("rispetta PUBLIC_URL e ne rimuove gli slash finali", () => {
    expect(loadWorkerConfig({ ...VALID, PUBLIC_URL: "https://stubwise.example.com" }).publicUrl).toBe(
      "https://stubwise.example.com",
    );
    expect(loadWorkerConfig({ ...VALID, PUBLIC_URL: "https://stubwise.example.com/" }).publicUrl).toBe(
      "https://stubwise.example.com",
    );
    // Vuoto (es. da .env.example) resta vuoto.
    expect(loadWorkerConfig({ ...VALID, PUBLIC_URL: "" }).publicUrl).toBe("");
  });

  it("rispetta MIRRORS_DIR, WORKER_CONCURRENCY e WORKER_STALE_MINUTES espliciti", () => {
    const config = loadWorkerConfig({
      ...VALID,
      MIRRORS_DIR: "/data/mirrors",
      WORKER_CONCURRENCY: "4",
      WORKER_STALE_MINUTES: "75",
    });
    expect(config.mirrorsDir).toBe("/data/mirrors");
    expect(config.concurrency).toBe(4);
    expect(config.staleAfterMinutes).toBe(75);
  });

  it("rispetta DATABASE_POOL_MAX esplicito e rifiuta valori fuori range", () => {
    expect(loadWorkerConfig({ ...VALID, DATABASE_POOL_MAX: "20" }).databasePoolMax).toBe(20);
    // Vuoto (es. da .env.example) usa il default 10.
    expect(loadWorkerConfig({ ...VALID, DATABASE_POOL_MAX: "" }).databasePoolMax).toBe(10);
    expect(() => loadWorkerConfig({ ...VALID, DATABASE_POOL_MAX: "0" })).toThrow(/DATABASE_POOL_MAX/);
    expect(() => loadWorkerConfig({ ...VALID, DATABASE_POOL_MAX: "101" })).toThrow(
      /DATABASE_POOL_MAX/,
    );
  });

  it("rispetta le variabili del fix in due fasi (modelli, flag, timeout)", () => {
    const config = loadWorkerConfig({
      ...VALID,
      FIX_PLAN_MODEL: "opus-4-8",
      FIX_EXECUTE_MODEL: "haiku",
      FIX_TWO_PHASE: "false",
      FIX_PLAN_TIMEOUT_MS: "300000",
    });
    expect(config.fixPlanModel).toBe("opus-4-8");
    expect(config.fixExecuteModel).toBe("haiku");
    expect(config.fixTwoPhase).toBe(false);
    expect(config.fixPlanTimeoutMs).toBe(300_000);
  });

  it("rispetta le variabili del self-repair (max attempts, timeout test); 0 = disattivato", () => {
    const config = loadWorkerConfig({
      ...VALID,
      SELF_REPAIR_MAX_ATTEMPTS: "0",
      SELF_REPAIR_TEST_TIMEOUT_MS: "120000",
    });
    expect(config.selfRepairMaxAttempts).toBe(0);
    expect(config.selfRepairTestTimeoutMs).toBe(120_000);
  });

  it("rispetta INSTALL_TIMEOUT_MS esplicito", () => {
    const config = loadWorkerConfig({ ...VALID, INSTALL_TIMEOUT_MS: "120000" });
    expect(config.installTimeoutMs).toBe(120_000);
  });

  it("rifiuta SELF_REPAIR_MAX_ATTEMPTS negativa e SELF_REPAIR_TEST_TIMEOUT_MS < 1", () => {
    expect(() => loadWorkerConfig({ ...VALID, SELF_REPAIR_MAX_ATTEMPTS: "-1" })).toThrow(
      /SELF_REPAIR_MAX_ATTEMPTS/,
    );
    expect(() => loadWorkerConfig({ ...VALID, SELF_REPAIR_TEST_TIMEOUT_MS: "0" })).toThrow(
      /SELF_REPAIR_TEST_TIMEOUT_MS/,
    );
  });

  it("variabili vuote (es. copiate da .env.example) usano il default", () => {
    const config = loadWorkerConfig({
      ...VALID,
      MIRRORS_DIR: "",
      WORKER_CONCURRENCY: "",
      WORKER_STALE_MINUTES: "",
      FIX_PLAN_MODEL: "",
      FIX_EXECUTE_MODEL: "",
      FIX_TWO_PHASE: "",
      FIX_PLAN_TIMEOUT_MS: "",
    });
    expect(config.mirrorsDir).toBe("/var/stubwise/mirrors");
    expect(config.concurrency).toBe(2);
    expect(config.staleAfterMinutes).toBe(150);
    expect(config.fixPlanModel).toBe("opus");
    expect(config.fixExecuteModel).toBe("sonnet");
    expect(config.fixTwoPhase).toBe(true);
    expect(config.fixPlanTimeoutMs).toBe(600_000);
    expect(config.selfRepairMaxAttempts).toBe(2);
    expect(config.selfRepairTestTimeoutMs).toBe(300_000);
  });

  it("rifiuta una WORKER_STALE_MINUTES non numerica o < 1", () => {
    expect(() => loadWorkerConfig({ ...VALID, WORKER_STALE_MINUTES: "tanto" })).toThrow(
      /WORKER_STALE_MINUTES/,
    );
    expect(() => loadWorkerConfig({ ...VALID, WORKER_STALE_MINUTES: "0" })).toThrow(
      /WORKER_STALE_MINUTES/,
    );
  });

  it("elenca tutte le variabili mancanti o non valide in un solo errore", () => {
    expect(() => loadWorkerConfig({})).toThrow(/DATABASE_URL[\s\S]*ENCRYPTION_KEY/);
  });

  it("rifiuta una ENCRYPTION_KEY che non è 32 byte in base64", () => {
    expect(() => loadWorkerConfig({ ...VALID, ENCRYPTION_KEY: "corta" })).toThrow(/ENCRYPTION_KEY/);
    expect(() =>
      loadWorkerConfig({ ...VALID, ENCRYPTION_KEY: randomBytes(16).toString("base64") }),
    ).toThrow(/ENCRYPTION_KEY/);
  });

  it("rifiuta una WORKER_CONCURRENCY non numerica o fuori range", () => {
    expect(() => loadWorkerConfig({ ...VALID, WORKER_CONCURRENCY: "zero" })).toThrow(
      /WORKER_CONCURRENCY/,
    );
    expect(() => loadWorkerConfig({ ...VALID, WORKER_CONCURRENCY: "0" })).toThrow(
      /WORKER_CONCURRENCY/,
    );
  });
});
