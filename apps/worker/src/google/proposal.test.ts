import { randomUUID } from "node:crypto";
import {
  calendarEvents as calendarEventsTable,
  emailMessages,
  emailProposals,
  googleAccounts,
  googleWorkspaces,
  notifications,
  projects,
  users,
  type Db,
} from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { t } from "@stubwise/i18n";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildCalendarProposalEvent,
  buildEmailProposalEvent,
  buildTriageProposalEvent,
  calendarDayUrl,
  gmailThreadUrl,
  googleProposalEventSchema,
  publishProposal,
  MAX_PROPOSAL_OPTIONS,
  type BuildEmailProposalArgs,
} from "./proposal.js";

/**
 * FASE D (fase 6, Task 10; ripartita per progetto in fase 6b, Task 5): da una
 * riga trattata alla proposta in inbox.
 *
 * Due metà con due rischi diversi, e i test li seguono separati:
 *
 *  1. **La costruzione** è pura, e il suo rischio è il DISALLINEAMENTO fra
 *     `options` e `actions` — che non dà nessun errore, fa eseguire l'azione
 *     sbagliata su una conferma data in buona fede. Ogni test che costruisce un
 *     evento riconta le due liste. Fase 6b: `buildEmailProposalEvent` riceve
 *     ora la riga FIGLIA (`email_proposals`, un progetto certo per riga), non
 *     più il messaggio con un progetto forse ambiguo.
 *  2. **La pubblicazione** tocca due tabelle e deve farlo INSIEME. Il suo
 *     rischio sono i due mezzi stati: una notifica senza la riga marcata (una
 *     card nuova a ogni tick sulla stessa email) e una riga marcata senza
 *     notifica (una proposta che non esiste e che nessuno ripescherà). Si
 *     verificano su un Postgres vero, perché è la transazione a garantirli.
 *     Fase 6b: il claim è sulla riga FIGLIA — due figli dello stesso messaggio
 *     si pubblicano senza contendersi il padre.
 */

vi.setConfig({ testTimeout: 60_000 });

let testDb: TestDb;
let db: Db;

const MAILBOX = "operatore@acme.com";

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
}, 120_000);

afterEach(async () => {
  await db.delete(calendarEventsTable);
  await db.delete(emailProposals);
  await db.delete(emailMessages);
  await db.delete(googleAccounts);
  await db.delete(googleWorkspaces);
  await db.delete(notifications);
  await db.delete(projects);
  await db.delete(users);
  vi.restoreAllMocks();
});

afterAll(async () => {
  await testDb.stop();
});

// ---------------------------------------------------------------------------
// Fixture pure
// ---------------------------------------------------------------------------

const PROJECT_A = "aa11bb22-1111-4222-8333-444455556666";
const PROJECT_B = "bb22cc33-2222-4333-8444-555566667777";
const TICKET_ID = "cc33dd44-3333-4444-8555-666677778888";

const NAMES = new Map([
  [PROJECT_A, "negozio-web"],
  [PROJECT_B, "portale-clienti"],
]);

/** Il messaggio PADRE, nella forma minima che il builder legge. */
function messageRow(overrides: Record<string, unknown> = {}) {
  return {
    threadId: "18f3a9c0d1e2f345",
    fromAddress: "laura@cliente.test",
    fromName: "Laura",
    subject: "Export degli ordini in CSV",
    receivedAt: new Date("2026-09-07T08:14:00.000Z"),
    ...overrides,
  };
}

/** La riga FIGLIA (`email_proposals`) di UN progetto: il progetto è certo. */
function proposalRow(projectId: string, overrides: Record<string, unknown> = {}) {
  return {
    projectId,
    classification: {
      signal: "request",
      summary: "Laura chiede l'export CSV.",
      recommendedIndex: 0,
      proposals: [
        {
          type: "create_backlog_item",
          projectId,
          title: "Export CSV dello storico ordini",
          consequence: "Entra nel backlog di discovery.",
        },
      ],
    } as Record<string, unknown>,
    ...overrides,
  };
}

function buildEmail(
  messageOverrides: Record<string, unknown> = {},
  proposalOverrides: Record<string, unknown> = {},
  projectId: string = PROJECT_A,
) {
  return buildEmailProposalEvent({
    lang: "it",
    message: messageRow(messageOverrides),
    proposal: proposalRow(projectId, proposalOverrides),
    mailboxEmail: MAILBOX,
    projectNames: NAMES,
  });
}

/**
 * Come `buildEmail`, ma bypassa i tipi: serve ai test che simulano un jsonb
 * CORROTTO o pre-esistente (`classification: null`, un valore non un
 * oggetto…) — casi che la colonna reale non produce (`NOT NULL`) ma che un
 * jsonb scritto da una versione precedente del codice può ancora avere.
 */
function buildEmailRaw(proposalOverrides: Record<string, unknown>) {
  return buildEmailProposalEvent({
    lang: "it",
    message: messageRow(),
    proposal: { projectId: PROJECT_A, ...proposalOverrides } as unknown as BuildEmailProposalArgs["proposal"],
    mailboxEmail: MAILBOX,
    projectNames: NAMES,
  });
}

// ---------------------------------------------------------------------------
// Costruzione — posta
// ---------------------------------------------------------------------------

describe("buildEmailProposalEvent", () => {
  it("una opzione per proposta, «Non fare nulla» SEMPRE ultima, azioni allineate", () => {
    const event = buildEmail();
    expect(event).not.toBeNull();
    expect(event?.kind).toBe("google.proposal");
    expect(event?.source).toBe("email");
    expect(event?.signal).toBe("request");
    expect(event?.allowFreeText).toBe(false);
    expect(event?.options).toHaveLength(2);
    // L'INVARIANTE, asserita e non sperata.
    expect(event?.actions).toHaveLength(event?.options.length ?? -1);
    expect(event?.actions[0]).toEqual({
      type: "create_backlog_item",
      projectId: PROJECT_A,
      title: "Export CSV dello storico ordini",
    });
    expect(event?.actions.at(-1)).toEqual({ type: "ignore" });
    // La `consequence` è l'unico pezzo di testo della card che scrive il
    // modello: l'etichetta viene da un template.
    expect(event?.options[0]?.consequence).toBe("Entra nel backlog di discovery.");
    expect(event?.options[0]?.label).toContain("Export CSV dello storico ordini");
    // Fase 6b: il progetto è CERTO — id e nome entrano SEMPRE, non più solo
    // quando il routing ha risolto un vincitore.
    expect(event?.projectId).toBe(PROJECT_A);
    expect(event?.projectName).toBe("negozio-web");
    expect(event?.receivedAt).toBe("2026-09-07T08:14:00.000Z");
  });

  it("la domanda NOMINA il progetto (template dedicato, fase 6b)", () => {
    // Con N card sullo stesso messaggio mittente e oggetto sono identici:
    // senza il nome del progetto le card sarebbero indistinguibili in inbox e
    // su Slack.
    const event = buildEmail();
    expect(event?.question).toContain("negozio-web");
    expect(event?.question).toContain("laura@cliente.test");
    expect(event?.question).toContain("Export degli ordini in CSV");
  });

  it("il link porta al THREAD dentro la casella giusta", () => {
    // `u/<email>` e non `u/0`: l'indice numerico è la posizione dell'account
    // nel browser di chi clicca, quindi porterebbe chi ha più account Google
    // sulla casella sbagliata. `#all` perché una email trattata è archiviata.
    expect(buildEmail()?.messageUrl).toBe(
      `https://mail.google.com/mail/u/${encodeURIComponent(MAILBOX)}/#all/18f3a9c0d1e2f345`,
    );
    expect(gmailThreadUrl("a+b@acme.test", "t1")).toBe(
      "https://mail.google.com/mail/u/a%2Bb%40acme.test/#all/t1",
    );
  });

  it("una proposta senza il referente che serve a eseguirla NON diventa opzione", () => {
    // `create_backlog_item` senza titolo non è confermabile: eseguirla non
    // produrrebbe niente. Ricontrollato QUI e non solo alla classificazione,
    // perché il jsonb può venire da una versione precedente del codice.
    const event = buildEmail(
      {},
      {
        classification: {
          signal: "request",
          recommendedIndex: 0,
          proposals: [
            { type: "create_backlog_item", projectId: PROJECT_A, consequence: "…" },
            {
              type: "comment_ticket",
              ticketId: TICKET_ID,
              ticketNumber: 42,
              body: "Rispondiamo a Laura.",
              consequence: "Il ticket riceve un commento.",
            },
          ],
        },
      },
    );
    expect(event?.options).toHaveLength(2);
    expect(event?.actions).toHaveLength(2);
    expect(event?.actions[0]).toEqual({
      type: "comment_ticket",
      ticketId: TICKET_ID,
      body: "Rispondiamo a Laura.",
    });
    expect(event?.options[0]?.label).toContain("#42");
  });

  it("`recommendedIndex` viene RIMAPPATO sulle proposte sopravvissute", () => {
    // La consigliata era la seconda; la prima cade. Copiare l'indice com'era
    // evidenzierebbe «Non fare nulla», cioè esattamente l'opposto.
    const event = buildEmail(
      {},
      {
        classification: {
          signal: "request",
          recommendedIndex: 1,
          proposals: [
            { type: "update_ticket", consequence: "…" },
            {
              type: "create_milestone",
              projectId: PROJECT_A,
              name: "Export entro il 30/09",
              dueDate: "2026-09-30T00:00:00.000Z",
              consequence: "Nasce una milestone.",
            },
          ],
        },
      },
    );
    expect(event?.recommendedIndex).toBe(0);
    expect(event?.actions[0]?.type).toBe("create_milestone");
  });

  it("un `recommendedIndex` oltre la fine ricade su 0, mai fuori dalle opzioni", () => {
    const event = buildEmail(
      {},
      { classification: { ...(proposalRow(PROJECT_A).classification as object), recommendedIndex: 7 } },
    );
    expect(event?.recommendedIndex).toBe(0);
    expect(googleProposalEventSchema.safeParse(event).success).toBe(true);
  });

  it("nessuna proposta eseguibile → nessun evento (non una card che chiede di archiviare)", () => {
    expect(
      buildEmail({}, { classification: { signal: "none", recommendedIndex: 0, proposals: [] } }),
    ).toBeNull();
    // Anche il jsonb marcio (pre-esistente, da una versione precedente del
    // codice): non c'è niente da proporre.
    expect(buildEmailRaw({ classification: null })).toBeNull();
    expect(buildEmailRaw({ classification: { proposals: "boh" } })).toBeNull();
  });

  it("il nome del progetto non risolto → nessun evento (non una card senza nome)", () => {
    // Fase 6b: il progetto è certo (`proposal.projectId`), ma se `projectNames`
    // non lo contiene la domanda non potrebbe nominarlo — la card sarebbe
    // indistinguibile dalle sue sorelle sullo stesso messaggio. Meglio niente
    // che una card ambigua.
    const event = buildEmailProposalEvent({
      lang: "it",
      message: messageRow(),
      proposal: proposalRow(PROJECT_A),
      mailboxEmail: MAILBOX,
      projectNames: new Map(), // vuota: PROJECT_A non si risolve
    });
    expect(event).toBeNull();
  });

  it("`choose_project` NON viene MAI generata: il progetto è già certo", () => {
    // Prima della fase 6b un progetto ambiguo produceva opzioni «Riguarda …».
    // Dal fan-out per progetto, la riga figlia porta già il progetto certo:
    // non c'è più un'ambiguità da chiedere qui. `choose_project` resta
    // un'azione VALIDA nell'unione e nell'esecutore, solo per le card
    // pubblicate prima di questa fase — mai generata da qui in poi.
    const event = buildEmail();
    expect(event?.actions.some((action) => action.type === "choose_project")).toBe(false);
  });

  it("le opzioni attive si fermano al tetto, e «Non fare nulla» resta comunque", () => {
    // Il tetto non è estetico: i bottoni di un DM Slack della domanda sono al
    // massimo quattro, e l'ultimo lo prende sempre «Non fare nulla».
    const proposals = Array.from({ length: 6 }, (_, index) => ({
      type: "create_backlog_item",
      projectId: PROJECT_A,
      title: `Voce ${index}`,
      consequence: "…",
    }));
    const event = buildEmail(
      {},
      { classification: { signal: "request", recommendedIndex: 0, proposals } },
    );
    expect(event?.options).toHaveLength(MAX_PROPOSAL_OPTIONS + 1);
    expect(event?.actions).toHaveLength(MAX_PROPOSAL_OPTIONS + 1);
    expect(event?.actions.at(-1)).toEqual({ type: "ignore" });
  });

  it("due figli dello stesso messaggio → progetti certi diversi, `proposalId` e domanda diversi", () => {
    // È il cuore del fan-out: STESSO messaggio (mittente/oggetto identici),
    // due FIGLI — due card, ciascuna col suo progetto certo. Senza il nome
    // del progetto nella domanda sarebbero indistinguibili in inbox.
    const eventA = buildEmail({}, {}, PROJECT_A);
    const eventB = buildEmail({}, {}, PROJECT_B);
    if (!eventA || !eventB) throw new Error("evento non costruito");

    expect(eventA.projectId).toBe(PROJECT_A);
    expect(eventB.projectId).toBe(PROJECT_B);
    expect(eventA.projectName).toBe("negozio-web");
    expect(eventB.projectName).toBe("portale-clienti");
    // Mittente e oggetto sono IDENTICI (stesso messaggio padre)...
    expect(eventA.from).toBe(eventB.from);
    expect(eventA.subject).toBe(eventB.subject);
    // ...ma la domanda no: nomina il progetto, quindi le distingue.
    expect(eventA.question).not.toBe(eventB.question);
    expect(eventA.question).toContain("negozio-web");
    expect(eventB.question).toContain("portale-clienti");
    // Ogni evento porta un `proposalId` proprio (l'ancora della sua notifica).
    expect(eventA.proposalId).not.toBe(eventB.proposalId);
  });
});

// ---------------------------------------------------------------------------
// Costruzione — calendario
// ---------------------------------------------------------------------------

/** Una riga `calendar_events` pronta per una proposta. */
function calendarRow(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    title: "Consegna al cliente",
    startsAt: new Date("2026-09-30T09:00:00.000Z"),
    organizer: "pm@acme.com",
    status: "confirmed" as string | null,
    projectId: PROJECT_A as string | null,
    proposalNotificationId: null as string | null,
    outcome: null as Record<string, unknown> | null,
    ...overrides,
  };
}

function buildCalendar(overrides: Record<string, unknown> = {}) {
  return buildCalendarProposalEvent({
    lang: "it",
    event: calendarRow(overrides),
    mailboxEmail: MAILBOX,
    projectNames: NAMES,
  });
}

describe("buildCalendarProposalEvent", () => {
  it("una sola opzione (la milestone) più «Non fare nulla», consigliata la prima", () => {
    const event = buildCalendar();
    expect(event?.source).toBe("calendar");
    // Il segnale è sempre `deadline`: è esattamente ciò che un appuntamento è,
    // e qui non gira nessun modello che possa dire altro.
    expect(event?.signal).toBe("deadline");
    expect(event?.options).toHaveLength(2);
    expect(event?.actions).toHaveLength(2);
    expect(event?.actions[0]).toEqual({
      type: "create_milestone",
      projectId: PROJECT_A,
      name: "Consegna al cliente entro il 2026-09-30",
      dueDate: "2026-09-30",
    });
    expect(event?.actions[1]).toEqual({ type: "ignore" });
    expect(event?.recommendedIndex).toBe(0);
    expect(event?.from).toBe("pm@acme.com");
    expect(event?.projectId).toBe(PROJECT_A);
    expect(event?.projectName).toBe("negozio-web");
  });

  it("il link porta alla GIORNATA dell'appuntamento nel calendario della casella", () => {
    // Non è il permalink dell'evento, e non può esserlo: `htmlLink` non ha una
    // colonna in `calendar_events`, e la proposta si pubblica leggendo la riga.
    expect(buildCalendar()?.messageUrl).toBe(
      `https://calendar.google.com/calendar/u/${encodeURIComponent(MAILBOX)}/r/day/2026/9/30`,
    );
    expect(calendarDayUrl("a@b.test", new Date("2026-01-05T23:30:00.000Z"))).toContain(
      "/r/day/2026/1/5",
    );
  });

  it("il cancello di `isReadyForProposal` vale anche qui, non solo nella query", () => {
    // È il contratto fra la fase 3 e questa: un chiamante nuovo non deve poterlo
    // aggirare scrivendosi una `where` sua.
    expect(buildCalendar({ status: "cancelled" })).toBeNull();
    expect(buildCalendar({ projectId: null })).toBeNull();
    expect(buildCalendar({ proposalNotificationId: randomUUID() })).toBeNull();
    expect(buildCalendar({ outcome: { type: "duplicate" } })).toBeNull();
    // Senza titolo non c'è una milestone che qualcuno confermerebbe con un tap.
    expect(buildCalendar({ title: "  " })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fase 6c — Task 5: la proposta di SMISTAMENTO, sul PADRE
// ---------------------------------------------------------------------------

function triageClassification(overrides: Record<string, unknown> = {}) {
  return {
    triage: true,
    signal: "request",
    summary: "Il cliente chiede qualcosa, ma non è chiaro per quale progetto.",
    suggestedProjectIds: [PROJECT_A, PROJECT_B],
    ...overrides,
  };
}

function buildTriage(
  classificationOverrides: Record<string, unknown> = {},
  messageOverrides: Record<string, unknown> = {},
) {
  return buildTriageProposalEvent({
    lang: "it",
    message: { ...messageRow(), classification: triageClassification(classificationOverrides), ...messageOverrides },
    mailboxEmail: MAILBOX,
    projectNames: NAMES,
  });
}

describe("buildTriageProposalEvent", () => {
  it("un'opzione choose_project PER progetto suggerito, più «Nessuno di questi» per ultima", () => {
    const event = buildTriage();
    expect(event?.source).toBe("email");
    expect(event?.signal).toBe("request");
    // NIENTE projectId/projectName: qui il progetto è ciò che manca.
    expect(event?.projectId).toBeUndefined();
    expect(event?.projectName).toBeUndefined();
    expect(event?.options).toHaveLength(3);
    expect(event?.actions).toEqual([
      { type: "choose_project", projectId: PROJECT_A },
      { type: "choose_project", projectId: PROJECT_B },
      { type: "ignore" },
    ]);
    // L'etichetta dell'ultima opzione NON è il generico "Non fare nulla":
    // è dedicata alla proposta di smistamento.
    expect(event?.options[2]?.label).not.toBe(event?.options[0]?.label);
  });

  it("la domanda riassume il segnale, NON nomina un progetto (a differenza di buildEmailProposalEvent)", () => {
    const event = buildTriage();
    expect(event?.question).not.toBe("");
    expect(event?.question).not.toContain(NAMES.get(PROJECT_A));
    expect(event?.question).not.toContain(NAMES.get(PROJECT_B));
  });

  it("smistamento senza suggerimenti: nasce comunque con la sola opzione 'nessuno di questi' — è VOLUTO, non un bug da correggere", () => {
    // Task 5 (fase 6c, rifinitura): `buildTriageProposalEvent` produce un
    // evento anche quando `suggestedProjectIds` è vuoto — nessun progetto
    // suggeribile, non solo nessun nome risolto. La card resta con la sola
    // opzione «Nessuno di questi»: è l'unico caso in cui una notifica
    // azionabile non offre azioni utili oltre ad archiviare, ed è
    // DELIBERATO — il maintainer vuole comunque sapere di un'email che ha
    // un segnale reale ma parla di un progetto non ancora in Stubwise. Chi
    // legge questo test in futuro non "corregga" il caso vuoto: la card a
    // una sola opzione è l'esito atteso, non un difetto della funzione.
    const event = buildTriage({ suggestedProjectIds: [] });
    expect(event).not.toBeNull();
    expect(event?.options).toHaveLength(1);
    expect(event?.options[0]?.label).toBe(t("it", "email.proposal.triageIgnore"));
    expect(event?.actions).toHaveLength(1);
    expect(event?.actions).toEqual([{ type: "ignore" }]);
    // La domanda riassume comunque il segnale, non resta vuota: la card
    // spiega perché è nata anche senza un progetto da nominare.
    expect(event?.question).not.toBe("");
  });

  it("un progetto suggerito il cui nome non si risolve più si salta, senza invalidare l'evento", () => {
    const ghostProjectId = randomUUID();
    const event = buildTriage({ suggestedProjectIds: [ghostProjectId, PROJECT_A] });
    expect(event).not.toBeNull();
    expect(event?.actions).toEqual([
      { type: "choose_project", projectId: PROJECT_A },
      { type: "ignore" },
    ]);
  });

  it("`triage` non booleano (jsonb malformato) → null", () => {
    expect(buildTriage({ triage: "true" })).toBeNull();
  });

  it("marcatore assente (non è una classificazione «da smistare») → null", () => {
    expect(
      buildTriageProposalEvent({
        lang: "it",
        message: { ...messageRow(), classification: { signal: "request", proposals: [] } },
        mailboxEmail: MAILBOX,
        projectNames: NAMES,
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Il cancello prima della publish
// ---------------------------------------------------------------------------

describe("googleProposalEventSchema", () => {
  it("rifiuta un evento con azioni e opzioni di lunghezza diversa", () => {
    const event = buildEmail();
    if (!event) throw new Error("evento non costruito");
    expect(
      googleProposalEventSchema.safeParse({ ...event, actions: event.actions.slice(0, 1) }).success,
    ).toBe(false);
  });

  it("rifiuta un `recommendedIndex` fuori dalle opzioni", () => {
    const event = buildEmail();
    if (!event) throw new Error("evento non costruito");
    expect(googleProposalEventSchema.safeParse({ ...event, recommendedIndex: 9 }).success).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Pubblicazione (Postgres vero)
// ---------------------------------------------------------------------------

async function seedOwner(): Promise<{ userId: string; accountId: string; projectId: string }> {
  const [user] = await db
    .insert(users)
    .values({ email: `u-${randomUUID()}@acme.com`, passwordHash: "x", role: "member" })
    .returning({ id: users.id });
  const [workspace] = await db
    .insert(googleWorkspaces)
    .values({
      name: "Acme",
      domains: ["acme.com"],
      clientId: "client-id",
      clientSecretEncrypted: "blob",
    })
    .returning({ id: googleWorkspaces.id });
  const [account] = await db
    .insert(googleAccounts)
    .values({
      userId: user!.id,
      workspaceId: workspace!.id,
      email: MAILBOX,
      googleSub: `sub-${randomUUID()}`,
      refreshTokenEncrypted: "blob",
    })
    .returning({ id: googleAccounts.id });
  const [project] = await db
    .insert(projects)
    .values({
      name: "negozio-web",
      slug: `negozio-${randomUUID().slice(0, 8)}`,
      ingestionKey: randomUUID(),
    })
    .returning({ id: projects.id });
  return { userId: user!.id, accountId: account!.id, projectId: project!.id };
}

async function seedProject(name: string): Promise<string> {
  const [row] = await db
    .insert(projects)
    .values({ name, slug: `${name}-${randomUUID().slice(0, 8)}`, ingestionKey: randomUUID() })
    .returning({ id: projects.id });
  return row!.id;
}

async function seedMessage(accountId: string): Promise<string> {
  const [row] = await db
    .insert(emailMessages)
    .values({
      accountId,
      gmailMessageId: `m-${randomUUID()}`,
      threadId: `t-${randomUUID()}`,
      fromAddress: "laura@cliente.test",
      receivedAt: new Date("2026-09-07T08:14:00.000Z"),
      status: "classified",
    })
    .returning({ id: emailMessages.id });
  return row!.id;
}

/** Una riga FIGLIA `classified`, di UN progetto, per il messaggio dato. */
async function seedChild(
  messageId: string,
  projectId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const [row] = await db
    .insert(emailProposals)
    .values({
      emailMessageId: messageId,
      projectId,
      status: "classified",
      classification: {
        signal: "request",
        recommendedIndex: 0,
        proposals: [
          {
            type: "create_backlog_item",
            projectId,
            title: "Export CSV",
            consequence: "Entra nel backlog.",
          },
        ],
      },
      ...overrides,
    })
    .returning({ id: emailProposals.id });
  return row!.id;
}

/** L'evento da pubblicare per il progetto dato (progetto certo, nome noto). */
function eventFor(projectId: string, projectName = "negozio-web") {
  const event = buildEmailProposalEvent({
    lang: "it",
    message: messageRow(),
    proposal: proposalRow(projectId),
    mailboxEmail: MAILBOX,
    projectNames: new Map([[projectId, projectName]]),
  });
  if (!event) throw new Error("evento non costruito");
  return event;
}

describe("publishProposal", () => {
  it("notifica e chiusura della riga FIGLIA nascono INSIEME; il padre NON si tocca", async () => {
    const { userId, accountId, projectId } = await seedOwner();
    const messageId = await seedMessage(accountId);
    const childId = await seedChild(messageId, projectId);
    const event = eventFor(projectId);

    const result = await publishProposal(db, {
      event,
      source: "email",
      rowId: childId,
      mailboxOwnerUserId: userId,
      projectId,
    });

    expect(result.ok).toBe(true);
    const rows = await db.select().from(notifications);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(userId);
    expect(rows[0]?.kind).toBe("google.proposal");
    // La riga FIGLIA sa quale card la rappresenta.
    const [child] = await db.select().from(emailProposals).where(eq(emailProposals.id, childId));
    expect(child?.status).toBe("proposed");
    expect(child?.proposalNotificationId).toBe(rows[0]?.id);
    // Fase 6b: il PADRE non è mai stato toccato — lo stato aggregato si
    // calcola in lettura, non si persiste qui.
    const [message] = await db.select().from(emailMessages).where(eq(emailMessages.id, messageId));
    expect(message?.status).toBe("classified");
    expect(message?.proposalNotificationId).toBeNull();
  });

  it("una seconda pubblicazione sullo STESSO figlio non passa, e NON lascia una notifica orfana", async () => {
    // È la corsa vera: due tick (o due worker) sulla stessa riga. Il claim è
    // l'ultima scrittura della transazione proprio perché il perdente si porti
    // via anche la propria notifica invece di lasciarne una in inbox.
    const { userId, accountId, projectId } = await seedOwner();
    const messageId = await seedMessage(accountId);
    const childId = await seedChild(messageId, projectId);

    expect(
      (
        await publishProposal(db, {
          event: eventFor(projectId),
          source: "email",
          rowId: childId,
          mailboxOwnerUserId: userId,
          projectId,
        })
      ).ok,
    ).toBe(true);

    const second = await publishProposal(db, {
      event: eventFor(projectId),
      source: "email",
      rowId: childId,
      mailboxOwnerUserId: userId,
      projectId,
    });

    expect(second).toEqual({ ok: false, reason: "not_claimable" });
    expect(await db.select().from(notifications)).toHaveLength(1);
  });

  it("due FIGLI dello stesso messaggio si pubblicano ENTRAMBI, senza contendersi il padre", async () => {
    // Il caso che il fan-out introduce: due card sulla stessa email, una per
    // progetto. Nessuna riga condivisa da claimare — ciascuna prende solo il
    // proprio figlio.
    const { userId, accountId, projectId: projectA } = await seedOwner();
    const projectB = await seedProject("portale-clienti");
    const messageId = await seedMessage(accountId);
    const childA = await seedChild(messageId, projectA);
    const childB = await seedChild(messageId, projectB);

    const resultA = await publishProposal(db, {
      event: eventFor(projectA, "negozio-web"),
      source: "email",
      rowId: childA,
      mailboxOwnerUserId: userId,
      projectId: projectA,
    });
    const resultB = await publishProposal(db, {
      event: eventFor(projectB, "portale-clienti"),
      source: "email",
      rowId: childB,
      mailboxOwnerUserId: userId,
      projectId: projectB,
    });

    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    if (!resultA.ok || !resultB.ok) throw new Error("pubblicazione fallita");
    // Due notifiche DISTINTE, una per figlio.
    expect(resultA.notificationId).not.toBe(resultB.notificationId);
    expect(await db.select().from(notifications)).toHaveLength(2);

    const [childRowA] = await db.select().from(emailProposals).where(eq(emailProposals.id, childA));
    const [childRowB] = await db.select().from(emailProposals).where(eq(emailProposals.id, childB));
    expect(childRowA?.proposalNotificationId).toBe(resultA.notificationId);
    expect(childRowB?.proposalNotificationId).toBe(resultB.notificationId);
    // Nessuno dei due si è preso la notifica dell'altro.
    expect(childRowA?.proposalNotificationId).not.toBe(childRowB?.proposalNotificationId);
  });

  it("pubblicazione IN PARALLELO di due figli dello stesso messaggio: entrambe riescono, il padre resta INTATTO", async () => {
    // Simula i due worker/tick della docstring: due chiamate concorrenti a
    // `publishProposal` sui due figli dello stesso padre. Nessuna delle due
    // scrive mai su `email_messages` — quindi non possono contendersi nulla lì.
    const { userId, accountId, projectId: projectA } = await seedOwner();
    const projectB = await seedProject("portale-clienti");
    const messageId = await seedMessage(accountId);
    const childA = await seedChild(messageId, projectA);
    const childB = await seedChild(messageId, projectB);

    const [before] = await db.select().from(emailMessages).where(eq(emailMessages.id, messageId));

    const [resultA, resultB] = await Promise.all([
      publishProposal(db, {
        event: eventFor(projectA, "negozio-web"),
        source: "email",
        rowId: childA,
        mailboxOwnerUserId: userId,
        projectId: projectA,
      }),
      publishProposal(db, {
        event: eventFor(projectB, "portale-clienti"),
        source: "email",
        rowId: childB,
        mailboxOwnerUserId: userId,
        projectId: projectB,
      }),
    ]);

    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    expect(await db.select().from(notifications)).toHaveLength(2);

    // Il padre non ha subito NESSUNA scrittura: stesso stato, stesso
    // `updatedAt` di prima delle due pubblicazioni concorrenti.
    const [after] = await db.select().from(emailMessages).where(eq(emailMessages.id, messageId));
    expect(after?.status).toBe(before?.status);
    expect(after?.proposalNotificationId).toBeNull();
    expect(after?.updatedAt.getTime()).toBe(before?.updatedAt.getTime());
  });

  it("nessun destinatario → nessuna scrittura, e la riga resta riproponibile", async () => {
    const { accountId, projectId } = await seedOwner();
    const messageId = await seedMessage(accountId);
    const childId = await seedChild(messageId, projectId);

    const result = await publishProposal(db, {
      event: eventFor(projectId),
      source: "email",
      rowId: childId,
      mailboxOwnerUserId: randomUUID(),
      projectId,
      // `publishNotification` è best-effort: su un proprietario inesistente
      // inghiotte e torna 0. Marcare comunque la riga `proposed` la
      // renderebbe una proposta che non esiste, e nessuno la ripescherebbe.
      publish: async () => ({ published: 0 }),
    });

    expect(result).toEqual({ ok: false, reason: "no_recipients" });
    expect(await db.select().from(notifications)).toHaveLength(0);
    const [child] = await db.select().from(emailProposals).where(eq(emailProposals.id, childId));
    expect(child?.status).toBe("classified");
    expect(child?.proposalNotificationId).toBeNull();
  });

  it("un evento disallineato non viene pubblicato affatto", async () => {
    const { userId, accountId, projectId } = await seedOwner();
    const messageId = await seedMessage(accountId);
    const childId = await seedChild(messageId, projectId);
    const event = eventFor(projectId);

    const result = await publishProposal(db, {
      event: { ...event, actions: event.actions.slice(0, 1) },
      source: "email",
      rowId: childId,
      mailboxOwnerUserId: userId,
      projectId,
    });

    expect(result).toEqual({ ok: false, reason: "invalid_event" });
    expect(await db.select().from(notifications)).toHaveLength(0);
  });

  it("sul calendario marca `proposal_notification_id` nella stessa transazione", async () => {
    const { userId, accountId, projectId } = await seedOwner();
    const [row] = await db
      .insert(calendarEventsTable)
      .values({
        accountId,
        googleEventId: `e-${randomUUID()}`,
        title: "Consegna al cliente",
        startsAt: new Date("2026-09-30T09:00:00.000Z"),
        organizer: "pm@acme.com",
        status: "confirmed",
        projectId,
        fingerprint: "2026-09-30 consegna al cliente",
      })
      .returning({ id: calendarEventsTable.id });

    const event = buildCalendarProposalEvent({
      lang: "it",
      event: calendarRow({ id: row!.id, projectId }),
      mailboxEmail: MAILBOX,
      projectNames: new Map([[projectId, "negozio-web"]]),
    });
    if (!event) throw new Error("evento di calendario non costruito");

    const result = await publishProposal(db, {
      event,
      source: "calendar",
      rowId: row!.id,
      mailboxOwnerUserId: userId,
      projectId,
    });

    expect(result.ok).toBe(true);
    const [after] = await db
      .select()
      .from(calendarEventsTable)
      .where(eq(calendarEventsTable.id, row!.id));
    const [notification] = await db.select().from(notifications);
    expect(after?.proposalNotificationId).toBe(notification?.id);
    // L'appuntamento non ha un esito: quello lo scrive chi ESEGUE la proposta.
    expect(after?.outcome).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Fase 6c — Task 5: `source: "email_triage"` claima il PADRE, non un figlio
  // -------------------------------------------------------------------------

  it("email_triage: notifica e chiusura del PADRE nascono INSIEME — nessun figlio coinvolto", async () => {
    const { userId, accountId } = await seedOwner();
    const projectId = await seedProject("negozio-web");
    const messageId = await seedMessage(accountId);
    const event = buildTriageProposalEvent({
      lang: "it",
      message: { ...messageRow(), classification: triageClassification({ suggestedProjectIds: [projectId] }) },
      mailboxEmail: MAILBOX,
      projectNames: new Map([[projectId, "negozio-web"]]),
    });
    if (!event) throw new Error("evento non costruito");

    const result = await publishProposal(db, {
      event,
      source: "email_triage",
      rowId: messageId,
      mailboxOwnerUserId: userId,
      // Niente `projectId`: qui non c'è ancora un progetto risolto.
    });

    expect(result.ok).toBe(true);
    const rows = await db.select().from(notifications);
    expect(rows).toHaveLength(1);
    const [message] = await db.select().from(emailMessages).where(eq(emailMessages.id, messageId));
    expect(message?.status).toBe("proposed");
    expect(message?.proposalNotificationId).toBe(rows[0]?.id);
    // Nessun figlio è mai stato toccato: non ce n'era nessuno da chiudere.
    expect(await db.select().from(emailProposals)).toEqual([]);
  });

  it("email_triage: una seconda pubblicazione sullo STESSO padre non passa, e NON lascia una notifica orfana", async () => {
    const { userId, accountId } = await seedOwner();
    const messageId = await seedMessage(accountId);
    const eventFor2 = () =>
      buildTriageProposalEvent({
        lang: "it",
        message: { ...messageRow(), classification: triageClassification({ suggestedProjectIds: [] }) },
        mailboxEmail: MAILBOX,
        projectNames: NAMES,
      })!;

    expect(
      (
        await publishProposal(db, {
          event: eventFor2(),
          source: "email_triage",
          rowId: messageId,
          mailboxOwnerUserId: userId,
        })
      ).ok,
    ).toBe(true);

    const second = await publishProposal(db, {
      event: eventFor2(),
      source: "email_triage",
      rowId: messageId,
      mailboxOwnerUserId: userId,
    });

    expect(second).toEqual({ ok: false, reason: "not_claimable" });
    // Una sola notifica, non due: il perdente non lascia orfani.
    expect(await db.select().from(notifications)).toHaveLength(1);
  });

  it("email_triage: un padre già `proposed` (non più `classified`) non è claimabile", async () => {
    const { userId, accountId } = await seedOwner();
    const [row] = await db
      .insert(emailMessages)
      .values({
        accountId,
        gmailMessageId: `m-${randomUUID()}`,
        threadId: `t-${randomUUID()}`,
        fromAddress: "laura@cliente.test",
        receivedAt: new Date("2026-09-07T08:14:00.000Z"),
        status: "proposed", // già pubblicata da qualcun altro (o da un giro precedente)
      })
      .returning({ id: emailMessages.id });
    const event = buildTriageProposalEvent({
      lang: "it",
      message: { ...messageRow(), classification: triageClassification({ suggestedProjectIds: [] }) },
      mailboxEmail: MAILBOX,
      projectNames: NAMES,
    })!;

    const result = await publishProposal(db, {
      event,
      source: "email_triage",
      rowId: row!.id,
      mailboxOwnerUserId: userId,
    });

    expect(result).toEqual({ ok: false, reason: "not_claimable" });
  });
});
