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
    // Domande dell'agente in pianificazione: 5 round per job.
    expect(config.agentQuestionMaxRounds).toBe(5);
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
    // Fase product (Fase B): default 12 pagine product per generazione.
    expect(config.docProductMaxPages).toBe(12);
    // Poller PR Review: default 60 secondi, sonnet, 50 turni, timeout 15'.
    expect(config.prReviewPollSeconds).toBe(60);
    expect(config.prReviewModel).toBe("sonnet");
    expect(config.prReviewMaxTurns).toBe(50);
    expect(config.prReviewTimeoutMs).toBe(900_000);
    // Resume poller dei limiti: default 5', soglia 95%, cooldown 60'.
    expect(config.limitResumePollMinutes).toBe(5);
    expect(config.limitResumeHeadroomPercent).toBe(95);
    expect(config.limitResumeCooldownMs).toBe(3_600_000);
    // Poller monitor: rollup ogni 5', valutazione alert ogni 1'.
    expect(config.monitorRollupIntervalMinutes).toBe(5);
    expect(config.monitorAlertIntervalMinutes).toBe(1);
    // Daily activity report: poller ogni 15', max 25 autori/progetto, retention 90 giorni.
    expect(config.dailyReportPollMinutes).toBe(15);
    expect(config.dailyReportMaxAuthorsPerProject).toBe(25);
    expect(config.dailyReportRetentionDays).toBe(90);
    // Backlog di discovery: soglie 0.90/0.78, poll 20", modello sonnet, timeout 15'.
    expect(config.backlogMergeThreshold).toBe(0.9);
    expect(config.backlogSimilarThreshold).toBe(0.78);
    expect(config.backlogPollSeconds).toBe(20);
    expect(config.backlogModel).toBe("sonnet");
    expect(config.backlogAgentTimeoutMs).toBe(900_000);
    // Sessione di analisi sul codice: poll 2", TTL 30', timeout 5', 15 turni.
    expect(config.backlogChatTurnPollSeconds).toBe(2);
    expect(config.backlogChatSessionTtlMinutes).toBe(30);
    expect(config.backlogChatTurnTimeoutMs).toBe(300_000);
    expect(config.backlogChatTurnMaxTurns).toBe(15);
    // Knowledge graph (graphify): volume /graphs, labeling on, binario
    // `graphify` in PATH, timeout di una invocazione 20'.
    expect(config.graphsDir).toBe("/graphs");
    expect(config.graphLabelEnabled).toBe(true);
    expect(config.graphifyBin).toBe("graphify");
    expect(config.graphBuildTimeoutMs).toBe(1_200_000);
    expect(config.graphPollSeconds).toBe(20);
  });

  it("rispetta gli override del knowledge graph e rifiuta i valori assurdi", () => {
    const config = loadWorkerConfig({
      ...VALID,
      GRAPHS_DIR: "/srv/graphs",
      GRAPH_LABEL_ENABLED: "false",
      GRAPHIFY_BIN: "/opt/graphify/bin/graphify",
      GRAPH_BUILD_TIMEOUT_MINUTES: "45",
      GRAPH_POLL_SECONDS: "45",
    });
    expect(config.graphPollSeconds).toBe(45);
    expect(config.graphsDir).toBe("/srv/graphs");
    expect(config.graphLabelEnabled).toBe(false);
    expect(config.graphifyBin).toBe("/opt/graphify/bin/graphify");
    // Minuti → ms.
    expect(config.graphBuildTimeoutMs).toBe(2_700_000);
    // Vuote (da .env.example) → default.
    const defaults = loadWorkerConfig({
      ...VALID,
      GRAPHS_DIR: "",
      GRAPH_LABEL_ENABLED: "",
      GRAPHIFY_BIN: "",
      GRAPH_BUILD_TIMEOUT_MINUTES: "",
      GRAPH_POLL_SECONDS: "",
    });
    expect(defaults.graphPollSeconds).toBe(20);
    expect(defaults.graphsDir).toBe("/graphs");
    expect(defaults.graphLabelEnabled).toBe(true);
    expect(defaults.graphifyBin).toBe("graphify");
    expect(defaults.graphBuildTimeoutMs).toBe(1_200_000);
    // Timeout < 1 minuto rifiutato; un booleano non riconosciuto pure.
    expect(() => loadWorkerConfig({ ...VALID, GRAPH_BUILD_TIMEOUT_MINUTES: "0" })).toThrow(
      /GRAPH_BUILD_TIMEOUT_MINUTES/,
    );
    expect(() => loadWorkerConfig({ ...VALID, GRAPH_LABEL_ENABLED: "si" })).toThrow(
      /GRAPH_LABEL_ENABLED/,
    );
    // 0 = poller disattivato (valore ammesso); negativo rifiutato.
    expect(loadWorkerConfig({ ...VALID, GRAPH_POLL_SECONDS: "0" }).graphPollSeconds).toBe(0);
    expect(() => loadWorkerConfig({ ...VALID, GRAPH_POLL_SECONDS: "-1" })).toThrow(
      /GRAPH_POLL_SECONDS/,
    );
  });

  it("rispetta gli override e i default della sessione di analisi sul codice", () => {
    const config = loadWorkerConfig({
      ...VALID,
      BACKLOG_CHAT_TURN_POLL_SECONDS: "0",
      BACKLOG_CHAT_SESSION_TTL_MINUTES: "45",
      BACKLOG_CHAT_TURN_TIMEOUT_MS: "120000",
      BACKLOG_CHAT_TURN_MAX_TURNS: "8",
    });
    expect(config.backlogChatTurnPollSeconds).toBe(0);
    expect(config.backlogChatSessionTtlMinutes).toBe(45);
    expect(config.backlogChatTurnTimeoutMs).toBe(120_000);
    expect(config.backlogChatTurnMaxTurns).toBe(8);
    // Vuote (da .env.example) → default.
    const defaults = loadWorkerConfig({
      ...VALID,
      BACKLOG_CHAT_TURN_POLL_SECONDS: "",
      BACKLOG_CHAT_SESSION_TTL_MINUTES: "",
    });
    expect(defaults.backlogChatTurnPollSeconds).toBe(2);
    expect(defaults.backlogChatSessionTtlMinutes).toBe(30);
    // TTL < 1 e turni < 1 rifiutati.
    expect(() => loadWorkerConfig({ ...VALID, BACKLOG_CHAT_SESSION_TTL_MINUTES: "0" })).toThrow(
      /BACKLOG_CHAT_SESSION_TTL_MINUTES/,
    );
    expect(() => loadWorkerConfig({ ...VALID, BACKLOG_CHAT_TURN_MAX_TURNS: "0" })).toThrow(
      /BACKLOG_CHAT_TURN_MAX_TURNS/,
    );
  });

  it("rispetta le soglie del backlog e le rifiuta fuori 0–1", () => {
    const config = loadWorkerConfig({
      ...VALID,
      BACKLOG_MERGE_THRESHOLD: "0.95",
      BACKLOG_SIMILAR_THRESHOLD: "0.8",
    });
    expect(config.backlogMergeThreshold).toBe(0.95);
    expect(config.backlogSimilarThreshold).toBe(0.8);
    // Vuote (es. da .env.example) usano i default.
    const defaults = loadWorkerConfig({
      ...VALID,
      BACKLOG_MERGE_THRESHOLD: "",
      BACKLOG_SIMILAR_THRESHOLD: "",
    });
    expect(defaults.backlogMergeThreshold).toBe(0.9);
    expect(defaults.backlogSimilarThreshold).toBe(0.78);
    expect(() => loadWorkerConfig({ ...VALID, BACKLOG_MERGE_THRESHOLD: "1.5" })).toThrow(
      /BACKLOG_MERGE_THRESHOLD/,
    );
    expect(() => loadWorkerConfig({ ...VALID, BACKLOG_SIMILAR_THRESHOLD: "-0.1" })).toThrow(
      /BACKLOG_SIMILAR_THRESHOLD/,
    );
  });

  it("rifiuta similar > merge con un errore chiaro", () => {
    expect(() =>
      loadWorkerConfig({
        ...VALID,
        BACKLOG_MERGE_THRESHOLD: "0.7",
        BACKLOG_SIMILAR_THRESHOLD: "0.8",
      }),
    ).toThrow(/BACKLOG_SIMILAR_THRESHOLD.*≤.*BACKLOG_MERGE_THRESHOLD/s);
  });

  it("rispetta BACKLOG_POLL_SECONDS, BACKLOG_MODEL e BACKLOG_AGENT_TIMEOUT_MS", () => {
    const config = loadWorkerConfig({
      ...VALID,
      BACKLOG_POLL_SECONDS: "30",
      BACKLOG_MODEL: "haiku",
      BACKLOG_AGENT_TIMEOUT_MS: "120000",
    });
    expect(config.backlogPollSeconds).toBe(30);
    expect(config.backlogModel).toBe("haiku");
    expect(config.backlogAgentTimeoutMs).toBe(120_000);
    // 0 = poller disabilitato.
    expect(loadWorkerConfig({ ...VALID, BACKLOG_POLL_SECONDS: "0" }).backlogPollSeconds).toBe(0);
    // Vuoti (es. da .env.example) usano i default.
    const defaults = loadWorkerConfig({
      ...VALID,
      BACKLOG_POLL_SECONDS: "",
      BACKLOG_MODEL: "",
      BACKLOG_AGENT_TIMEOUT_MS: "",
    });
    expect(defaults.backlogPollSeconds).toBe(20);
    expect(defaults.backlogModel).toBe("sonnet");
    expect(defaults.backlogAgentTimeoutMs).toBe(900_000);
    expect(() => loadWorkerConfig({ ...VALID, BACKLOG_POLL_SECONDS: "-1" })).toThrow(
      /BACKLOG_POLL_SECONDS/,
    );
    expect(() => loadWorkerConfig({ ...VALID, BACKLOG_AGENT_TIMEOUT_MS: "0" })).toThrow(
      /BACKLOG_AGENT_TIMEOUT_MS/,
    );
  });

  it("rispetta DAILY_REPORT_POLL_MINUTES esplicito, 0 = disabilitato e rifiuta i non validi", () => {
    expect(
      loadWorkerConfig({ ...VALID, DAILY_REPORT_POLL_MINUTES: "30" }).dailyReportPollMinutes,
    ).toBe(30);
    expect(
      loadWorkerConfig({ ...VALID, DAILY_REPORT_POLL_MINUTES: "0" }).dailyReportPollMinutes,
    ).toBe(0);
    // Vuoto (es. da .env.example) usa il default 15.
    expect(loadWorkerConfig({ ...VALID, DAILY_REPORT_POLL_MINUTES: "" }).dailyReportPollMinutes).toBe(
      15,
    );
    expect(() => loadWorkerConfig({ ...VALID, DAILY_REPORT_POLL_MINUTES: "-1" })).toThrow(
      /DAILY_REPORT_POLL_MINUTES/,
    );
    expect(() => loadWorkerConfig({ ...VALID, DAILY_REPORT_POLL_MINUTES: "abc" })).toThrow(
      /DAILY_REPORT_POLL_MINUTES/,
    );
  });

  it("rispetta DAILY_REPORT_MAX_AUTHORS_PER_PROJECT esplicito e rifiuta < 1", () => {
    expect(
      loadWorkerConfig({ ...VALID, DAILY_REPORT_MAX_AUTHORS_PER_PROJECT: "10" })
        .dailyReportMaxAuthorsPerProject,
    ).toBe(10);
    // Vuoto (es. da .env.example) usa il default 25.
    expect(
      loadWorkerConfig({ ...VALID, DAILY_REPORT_MAX_AUTHORS_PER_PROJECT: "" })
        .dailyReportMaxAuthorsPerProject,
    ).toBe(25);
    expect(() =>
      loadWorkerConfig({ ...VALID, DAILY_REPORT_MAX_AUTHORS_PER_PROJECT: "0" }),
    ).toThrow(/DAILY_REPORT_MAX_AUTHORS_PER_PROJECT/);
  });

  it("rispetta DAILY_REPORT_RETENTION_DAYS esplicito e rifiuta < 1", () => {
    expect(
      loadWorkerConfig({ ...VALID, DAILY_REPORT_RETENTION_DAYS: "30" }).dailyReportRetentionDays,
    ).toBe(30);
    // Vuoto (es. da .env.example) usa il default 90.
    expect(
      loadWorkerConfig({ ...VALID, DAILY_REPORT_RETENTION_DAYS: "" }).dailyReportRetentionDays,
    ).toBe(90);
    expect(() => loadWorkerConfig({ ...VALID, DAILY_REPORT_RETENTION_DAYS: "0" })).toThrow(
      /DAILY_REPORT_RETENTION_DAYS/,
    );
  });

  it("rispetta MONITOR_ROLLUP_INTERVAL_MINUTES esplicito, 0 = disabilitato e rifiuta i fuori range", () => {
    expect(
      loadWorkerConfig({ ...VALID, MONITOR_ROLLUP_INTERVAL_MINUTES: "15" })
        .monitorRollupIntervalMinutes,
    ).toBe(15);
    expect(
      loadWorkerConfig({ ...VALID, MONITOR_ROLLUP_INTERVAL_MINUTES: "0" })
        .monitorRollupIntervalMinutes,
    ).toBe(0);
    // Vuoto (es. da .env.example) usa il default 5.
    expect(
      loadWorkerConfig({ ...VALID, MONITOR_ROLLUP_INTERVAL_MINUTES: "" })
        .monitorRollupIntervalMinutes,
    ).toBe(5);
    expect(() => loadWorkerConfig({ ...VALID, MONITOR_ROLLUP_INTERVAL_MINUTES: "abc" })).toThrow(
      /MONITOR_ROLLUP_INTERVAL_MINUTES/,
    );
    expect(() => loadWorkerConfig({ ...VALID, MONITOR_ROLLUP_INTERVAL_MINUTES: "-1" })).toThrow(
      /MONITOR_ROLLUP_INTERVAL_MINUTES/,
    );
    expect(() => loadWorkerConfig({ ...VALID, MONITOR_ROLLUP_INTERVAL_MINUTES: "1441" })).toThrow(
      /MONITOR_ROLLUP_INTERVAL_MINUTES/,
    );
  });

  it("rispetta MONITOR_ALERT_INTERVAL_MINUTES esplicito, 0 = disabilitato e rifiuta i fuori range", () => {
    expect(
      loadWorkerConfig({ ...VALID, MONITOR_ALERT_INTERVAL_MINUTES: "5" })
        .monitorAlertIntervalMinutes,
    ).toBe(5);
    expect(
      loadWorkerConfig({ ...VALID, MONITOR_ALERT_INTERVAL_MINUTES: "0" })
        .monitorAlertIntervalMinutes,
    ).toBe(0);
    // Vuoto (es. da .env.example) usa il default 1.
    expect(
      loadWorkerConfig({ ...VALID, MONITOR_ALERT_INTERVAL_MINUTES: "" })
        .monitorAlertIntervalMinutes,
    ).toBe(1);
    expect(() => loadWorkerConfig({ ...VALID, MONITOR_ALERT_INTERVAL_MINUTES: "abc" })).toThrow(
      /MONITOR_ALERT_INTERVAL_MINUTES/,
    );
    expect(() => loadWorkerConfig({ ...VALID, MONITOR_ALERT_INTERVAL_MINUTES: "-1" })).toThrow(
      /MONITOR_ALERT_INTERVAL_MINUTES/,
    );
    expect(() => loadWorkerConfig({ ...VALID, MONITOR_ALERT_INTERVAL_MINUTES: "61" })).toThrow(
      /MONITOR_ALERT_INTERVAL_MINUTES/,
    );
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

  it("rispetta DOC_PRODUCT_MAX_PAGES esplicito e 0 = fase product disattivata", () => {
    expect(loadWorkerConfig({ ...VALID, DOC_PRODUCT_MAX_PAGES: "6" }).docProductMaxPages).toBe(6);
    // 0 = fase product spenta (retrocompatibilità totale).
    expect(loadWorkerConfig({ ...VALID, DOC_PRODUCT_MAX_PAGES: "0" }).docProductMaxPages).toBe(0);
    // Vuoto (es. da .env.example) usa il default 12.
    expect(loadWorkerConfig({ ...VALID, DOC_PRODUCT_MAX_PAGES: "" }).docProductMaxPages).toBe(12);
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

  it("rispetta AGENT_QUESTION_MAX_ROUNDS e rifiuta i valori sotto 1", () => {
    const config = loadWorkerConfig({ ...VALID, AGENT_QUESTION_MAX_ROUNDS: "2" });
    expect(config.agentQuestionMaxRounds).toBe(2);
    // Vuota (da .env.example) → default.
    const defaults = loadWorkerConfig({ ...VALID, AGENT_QUESTION_MAX_ROUNDS: "" });
    expect(defaults.agentQuestionMaxRounds).toBe(5);
    // 0 NON è "domande disattivate": il tetto è il numero di domande AMMESSE e
    // sotto 1 non avrebbe significato (il server MCP degraderebbe sul suo
    // default, cioè l'opposto di quel che si è chiesto).
    expect(() => loadWorkerConfig({ ...VALID, AGENT_QUESTION_MAX_ROUNDS: "0" })).toThrow(
      /AGENT_QUESTION_MAX_ROUNDS/,
    );
    expect(() => loadWorkerConfig({ ...VALID, AGENT_QUESTION_MAX_ROUNDS: "due" })).toThrow(
      /AGENT_QUESTION_MAX_ROUNDS/,
    );
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
