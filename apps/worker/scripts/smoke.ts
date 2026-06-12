/**
 * Smoke test MANUALE della pipeline reale (Task 26).
 *
 * Esercita l'INTERA pipeline del worker (triage → fix → push branch →
 * apertura PR) sullo STESSO codice di produzione (createHandler/runTriage/
 * runFix), scambiando solo ciò che ogni modalità richiede. NON è un test
 * automatico (niente vitest): si lancia a mano con
 *
 *   pnpm --filter @stubwise/worker smoke -- --local      (default)
 *   pnpm --filter @stubwise/worker smoke -- --remote
 *
 * ============================ Modalità ============================
 *
 * --local (default): lo smoke più economico, NESSUNA dipendenza esterna oltre
 *   a Docker (per Postgres) e a un `claude` autenticato.
 *   - origin git BARE locale in tmpdir, con un piccolo progetto Node che ha un
 *     bug PIANTATO e un test reale (node:test) che lo DIMOSTRA (fallisce);
 *   - Postgres reale: testcontainers (default) oppure SMOKE_DATABASE_URL;
 *   - ClaudeCliRunner REALE se `claude` è sul PATH ed è autenticato; se non
 *     c'è, lo smoke STAMPA un messaggio e esce 0 (skip): la pipeline non si
 *     finge mai, o gira sul modello vero o si salta;
 *   - provider PR FINTO: cattura titolo/corpo della PR e li stampa invece di
 *     chiamare un'API (nessuna rete verso GitHub/Bitbucket).
 *   Risultato atteso: il modello reale localizza il bug nel repo locale,
 *   applica il fix, scrive il report; il worker committa, pusha il branch
 *   sull'origin locale e "apre" la PR (catturata). Si verifica a video.
 *
 * --remote: pipeline COMPLETAMENTE reale (clone dal provider vero, apertura PR
 *   vera). Guidata da env, NON eseguibile in CI / da un agente:
 *     SMOKE_DATABASE_URL    Postgres reale con lo schema già migrato
 *     SMOKE_ENCRYPTION_KEY  la STESSA chiave del server (base64, 32 byte)
 *     SMOKE_PROJECT_SLUG    slug di un progetto già esistente nel DB
 *     SMOKE_TICKET_NUMBER   (opz.) numero di un ticket esistente del progetto;
 *                           se assente lo smoke crea un ticket di prova
 *     SMOKE_TICKET_TITLE / SMOKE_TICKET_BODY  (opz.) per il ticket creato
 *   Usa ClaudeCliRunner reale, MirrorManager reale e getProvider reale: apre
 *   una PR VERA sul repo del progetto. Da lanciare consapevolmente.
 *
 * Flag comuni:
 *   --keep   non rimuovere tmpdir/container a fine run (per ispezionare).
 */

import {
  aiJobs,
  comments,
  createDb,
  encrypt,
  gitAccounts,
  projects,
  runMigrations,
  tickets,
  type Db,
  type DbHandle,
} from "@stubwise/db";
import { getProvider, type GitProvider } from "@stubwise/git";
import type { GitProviderKind } from "@stubwise/shared";
import { and, eq } from "drizzle-orm";
import { execa } from "execa";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildAgentEnv, ClaudeCliRunner } from "../src/agent/claude-cli.js";
import { MirrorManager } from "../src/git/mirrors.js";
import { createHandler } from "../src/handler.js";
import { claimNextJob } from "../src/queue.js";

/* ------------------------------------------------------------------ *
 * Parsing degli argomenti
 * ------------------------------------------------------------------ */

interface Args {
  mode: "local" | "remote";
  keep: boolean;
}

function parseArgs(argv: string[]): Args {
  let mode: "local" | "remote" = "local";
  let keep = false;
  for (const arg of argv) {
    // pnpm può inoltrare il separatore `--` come argomento letterale: ignoralo.
    if (arg === "--") continue;
    else if (arg === "--local") mode = "local";
    else if (arg === "--remote") mode = "remote";
    else if (arg === "--keep") keep = true;
    else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      console.error(`Argomento sconosciuto: ${arg}`);
      printUsage();
      process.exit(2);
    }
  }
  return { mode, keep };
}

function printUsage(): void {
  console.error(
    [
      "Uso: pnpm --filter @stubwise/worker smoke -- [--local|--remote] [--keep]",
      "",
      "  --local   (default) origin git locale + Postgres effimero + provider PR finto,",
      "            ma ClaudeCliRunner REALE. Nessuna dipendenza esterna oltre Docker e claude.",
      "  --remote  pipeline reale guidata da env (SMOKE_DATABASE_URL, SMOKE_ENCRYPTION_KEY,",
      "            SMOKE_PROJECT_SLUG, SMOKE_TICKET_NUMBER): apre una PR VERA.",
      "  --keep    non rimuovere tmpdir/container a fine run.",
    ].join("\n"),
  );
}

/* ------------------------------------------------------------------ *
 * Utilità comuni
 * ------------------------------------------------------------------ */

const log = (msg: string): void => console.error(`[smoke] ${msg}`);
const section = (title: string): void => console.error(`\n==== ${title} ====`);

/** Esito della verifica del CLI claude. */
type ClaudeStatus = "ready" | "missing" | "unauthenticated";

/**
 * Verifica che `claude` sia presente E autenticato per l'uso headless (`-p`).
 * `claude --version` NON basta: ritorna 0 anche senza login, ma l'invocazione
 * headless reale fallisce poi con "Not logged in". Qui si fa un probe headless
 * minimo (prompt banale, 1 turno): distingue binario assente, sessione non
 * autenticata e CLI pronto, così lo smoke può saltare pulito (exit 0) invece
 * di scambiare un problema di setup per un fallimento della pipeline.
 *
 * CRUCIALE: il probe usa lo STESSO env del ClaudeCliRunner (allowlist via
 * buildAgentEnv + extendEnv:false). Il runner non eredita l'intero process.env
 * per sicurezza, quindi un'auth che vive in una var fuori dall'allowlist
 * (es. un token in una var con prefisso non whitelistato) farebbe passare un
 * probe con env completo ma poi FALLIRE il run reale. Replicando l'env del
 * runner il verdetto del probe è fedele a ciò che farà la pipeline.
 */
async function checkClaude(): Promise<ClaudeStatus> {
  try {
    await execa("claude", ["--version"], { timeout: 15_000 });
  } catch {
    return "missing";
  }
  try {
    const { all } = await execa(
      "claude",
      ["-p", "--output-format", "text", "--max-turns", "1"],
      {
        input: "Reply with the single word: ok",
        timeout: 60_000,
        all: true,
        reject: false,
        extendEnv: false,
        env: buildAgentEnv(process.env),
      },
    );
    if (/not logged in|please run \/login|invalid api key|authentication/i.test(all ?? "")) {
      return "unauthenticated";
    }
    return "ready";
  } catch {
    // Spawn/timeout del probe: trattato come non pronto (skip prudente).
    return "unauthenticated";
  }
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execa("git", args, { cwd });
  return stdout;
}

/** Stampa lo stato finale di job e ticket leggendolo dal DB. */
async function reportOutcome(db: Db, jobId: string, ticketId: string): Promise<void> {
  const [job] = await db.select().from(aiJobs).where(eq(aiJobs.id, jobId));
  const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
  const aiComments = await db
    .select({ body: comments.body })
    .from(comments)
    .where(and(eq(comments.ticketId, ticketId), eq(comments.authorType, "ai")));

  section("ESITO PIPELINE");
  log(`stato job:    ${job?.status ?? "(job sparito?)"}`);
  log(`stato ticket: ${ticket?.status ?? "(ticket sparito?)"}`);
  if (job?.prUrl) log(`PR url (DB):  ${job.prUrl}`);
  if (job?.error) log(`errore job:   ${job.error}`);
  for (const c of aiComments) {
    log(`commento AI:  ${c.body.split("\n")[0]}`);
  }
  section("LOG DEL JOB");
  console.error(job?.log ?? "(nessun log)");
}

/* ------------------------------------------------------------------ *
 * Provider PR finto (solo --local): cattura openPullRequest
 * ------------------------------------------------------------------ */

interface CapturedPr {
  branch: string;
  title: string;
  body: string;
}

function makeFakeProvider(captured: CapturedPr[]): (
  kind: GitProviderKind,
) => Pick<GitProvider, "openPullRequest"> {
  return () => ({
    async openPullRequest(_p, pr) {
      captured.push({ branch: pr.branch, title: pr.title, body: pr.body });
      // URL fittizio plausibile: il worker lo salva su aiJobs.prUrl e nel commento.
      return { url: `https://example.invalid/pull/${captured.length}` };
    },
  });
}

/* ------------------------------------------------------------------ *
 * Fixture del repo buggy (solo --local): generata inline
 * ------------------------------------------------------------------ */

const PKG_JSON = JSON.stringify(
  {
    name: "stubwise-smoke-fixture",
    version: "1.0.0",
    private: true,
    type: "commonjs",
    scripts: { test: "node --test" },
  },
  null,
  2,
);

// Bug PIANTATO: slugify lascia cadere il primo carattere (slice(1) invece di
// trim()), quindi "Hello World" → "ello-world". Bug netto, facile da localizzare
// dal test che fallisce, ma reale (sbaglia l'output, non crasha).
const SRC_BUGGY = `'use strict';

/**
 * Trasforma un titolo in uno slug URL-safe: minuscolo, spazi → trattini,
 * niente caratteri non alfanumerici ai bordi.
 */
function slugify(title) {
  // BUG: slice(1) scarta il primo carattere invece di fare trim().
  return title
    .slice(1)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

module.exports = { slugify };
`;

const TEST_FILE = `'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { slugify } = require('./slugify');

test('slugify trasforma un titolo in slug senza perdere caratteri', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});

test('slugify gestisce spazi multipli e simboli', () => {
  assert.equal(slugify('  Ciao, Mondo!  '), 'ciao-mondo');
});
`;

const README = `# Stubwise smoke fixture

Piccolo progetto Node con un bug piantato in \`slugify.js\` e un test
(\`slugify.test.js\`) che lo dimostra. Usato dallo smoke test della pipeline:
il modello deve localizzare il bug, correggerlo e far passare \`npm test\`.
`;

/** Crea un origin BARE con dentro la fixture buggy, già committata su main. */
async function seedBuggyOrigin(root: string): Promise<{ bareDir: string; url: string }> {
  const bareDir = join(root, "origin.git");
  await execa("git", ["init", "--bare", "-b", "main", bareDir]);

  const work = join(root, "seed");
  await mkdir(work, { recursive: true });
  await execa("git", ["init", "-b", "main", work]);
  await git(["remote", "add", "origin", bareDir], work);

  await writeFile(join(work, "package.json"), `${PKG_JSON}\n`);
  await writeFile(join(work, "slugify.js"), SRC_BUGGY);
  await writeFile(join(work, "slugify.test.js"), TEST_FILE);
  await writeFile(join(work, "README.md"), README);

  await git(["add", "."], work);
  await git(
    ["-c", "user.name=Smoke Seed", "-c", "user.email=seed@stubwise.test", "commit", "-m", "seed buggy fixture"],
    work,
  );
  await git(["push", "origin", "main"], work);
  return { bareDir, url: pathToFileURL(bareDir).href };
}

/* ------------------------------------------------------------------ *
 * Postgres: testcontainers oppure SMOKE_DATABASE_URL
 * ------------------------------------------------------------------ */

interface PgHandle {
  db: Db;
  handle: DbHandle;
  stop(): Promise<void>;
}

/**
 * Apre un Postgres con lo schema migrato. Se SMOKE_DATABASE_URL è impostata ci
 * si connette (lo schema deve già esistere o viene migrato); altrimenti si
 * avvia un container effimero via testcontainers (import dinamico: è una
 * devDependency, non deve pesare sul bundle del worker).
 */
async function openPostgres(): Promise<PgHandle> {
  const provided = process.env.SMOKE_DATABASE_URL;
  if (provided) {
    log(`Postgres: uso SMOKE_DATABASE_URL`);
    const handle = createDb(provided);
    await runMigrations(handle.db);
    return {
      db: handle.db,
      handle,
      async stop() {
        await handle.client.end();
      },
    };
  }

  log("Postgres: avvio un container effimero (testcontainers)…");
  const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
  const container = await new PostgreSqlContainer("postgres:17-alpine").start();
  const handle = createDb(container.getConnectionUri());
  await runMigrations(handle.db);
  return {
    db: handle.db,
    handle,
    async stop() {
      await handle.client.end();
      await container.stop();
    },
  };
}

/* ------------------------------------------------------------------ *
 * MODALITÀ LOCAL
 * ------------------------------------------------------------------ */

async function runLocal(keep: boolean): Promise<number> {
  section("SMOKE — MODALITÀ LOCAL");

  log("verifico il CLI claude (presenza + autenticazione headless)…");
  const status = await checkClaude();
  if (status === "missing") {
    log("`claude` non disponibile sul PATH: smoke saltato (la pipeline non si finge mai).");
    log("Installa/autentica il CLI claude e riprova: lo smoke locale gira sul modello vero.");
    return 0; // skip pulito, non un fallimento.
  }
  if (status === "unauthenticated") {
    log("`claude` presente ma NON autenticato per l'uso headless (`claude -p`): smoke saltato.");
    log("Esegui `claude` e completa il login, poi riprova: lo smoke locale gira sul modello vero.");
    return 0; // skip pulito: setup mancante, non un fallimento della pipeline.
  }
  log("`claude` trovato e autenticato: la pipeline girerà sul modello REALE.");

  const encryptionKey = randomBytes(32);
  const root = await mkdtemp(join(tmpdir(), "stubwise-smoke-"));
  const cleanups: Array<() => Promise<void>> = [];
  cleanups.push(() => rm(root, { recursive: true, force: true }));

  let pg: PgHandle | null = null;
  const captured: CapturedPr[] = [];

  try {
    const origin = await seedBuggyOrigin(root);
    log(`origin buggy creato: ${origin.url}`);

    pg = await openPostgres();
    const db = pg.db;

    // Progetto: provider "github" (le sue chiamate di rete sono FINTE qui), ma
    // repoUrl è il file:// dell'origin locale, così MirrorManager clona davvero
    // dal locale (mirrorRemoteUrl lascia passare gli URL non-https invariati).
    // Le credenziali vivono sull'account git collegato, non sul progetto.
    const [account] = await db
      .insert(gitAccounts)
      .values({
        name: "Smoke Account",
        provider: "github",
        encryptedCredentials: encrypt(JSON.stringify({ token: "smoke-token" }), encryptionKey),
      })
      .returning();
    if (!account) throw new Error("insert dell'account git non ha restituito la riga");
    const [project] = await db
      .insert(projects)
      .values({
        name: "Smoke Local",
        slug: `smoke-local-${Date.now()}`,
        provider: "github",
        gitAccountId: account.id,
        repoUrl: origin.url,
        defaultBranch: "main",
        ingestionKey: `smoke-ingestion-${Date.now()}`,
      })
      .returning();
    if (!project) throw new Error("insert del progetto non ha restituito la riga");

    // Ticket realistico: titolo + body + payload tecnico (stack che punta al
    // file buggy), come arriverebbe dall'SDK.
    const [ticket] = await db
      .insert(tickets)
      .values({
        projectId: project.id,
        number: 1,
        title: "slugify perde il primo carattere del titolo",
        body:
          "La funzione slugify() in slugify.js restituisce uno slug a cui manca il primo carattere. " +
          'Esempio: slugify("Hello World") restituisce "ello-world" invece di "hello-world". ' +
          "Il test slugify.test.js fallisce. Atteso: lo slug minuscolo con i trattini, senza perdere caratteri.",
        type: "bug",
        priority: "high",
        source: "sdk_error",
        technicalPayload: {
          message: 'AssertionError: slugify("Hello World") === "hello-world"',
          stack:
            "AssertionError [ERR_ASSERTION]: Expected 'hello-world' but got 'ello-world'\n" +
            "    at TestContext.<anonymous> (slugify.test.js:7:10)\n" +
            "    at slugify (slugify.js:9:6)",
        },
      })
      .returning();
    if (!ticket) throw new Error("insert del ticket non ha restituito la riga");

    await db.insert(aiJobs).values({ ticketId: ticket.id });
    log(`ticket #${ticket.number} e job in coda creati`);

    const mirrors = new MirrorManager({ mirrorsDir: join(root, "mirrors") });
    const handler = createHandler({
      db,
      runner: new ClaudeCliRunner(),
      mirrors,
      encryptionKey,
      getProviderFn: makeFakeProvider(captured),
    });

    const job = await claimNextJob(db);
    if (!job) throw new Error("nessun job in coda da reclamare");

    section("ESECUZIONE PIPELINE (modello reale: può durare minuti)");
    log("triage → fix → push → openPullRequest (PR catturata)…");
    const startedAt = Date.now();
    await handler(job);
    log(`pipeline conclusa in ${Math.round((Date.now() - startedAt) / 1000)}s`);

    // Diagnostica del repo: il branch è davvero arrivato sull'origin locale?
    section("STATO DEL REPO");
    const branches = await git(["branch", "--list", "stubwise/ticket-1"], origin.bareDir);
    if (branches.includes("stubwise/ticket-1")) {
      log("branch stubwise/ticket-1 pushato sull'origin locale: SÌ");
      const subject = await git(
        ["log", "-1", "--format=%an <%ae> — %s", "stubwise/ticket-1"],
        origin.bareDir,
      );
      log(`commit sul branch: ${subject}`);
      const diff = await git(["diff", "--stat", "main", "stubwise/ticket-1"], origin.bareDir);
      log(`diff vs main:\n${diff}`);
    } else {
      log("branch stubwise/ticket-1 pushato sull'origin locale: NO (nessuna modifica?)");
    }

    if (captured.length > 0) {
      const pr = captured[0]!;
      section("PR CATTURATA (corpo = report dell'agente)");
      log(`titolo: ${pr.title}`);
      log(`branch: ${pr.branch}`);
      console.error(`\n--- corpo PR ---\n${pr.body}\n--- fine corpo ---`);
    } else {
      log("nessuna PR catturata (il fix non ha prodotto modifiche o è fallito a monte).");
    }

    await reportOutcome(db, job.id, ticket.id);

    // Verdetto: lo smoke è un controllo a vista, ma diamo un segnale di uscita.
    const [finalJob] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
    if (finalJob?.status === "pr_opened") {
      section("SMOKE OK — PR aperta dal modello reale sul repo locale.");
      return 0;
    }
    if (finalJob?.status === "skipped") {
      section("SMOKE — triage ha deciso SKIP/DUPLICATE (job chiuso senza fix). Rivedi il prompt/ticket.");
      return 0;
    }
    section(`SMOKE — job terminato '${finalJob?.status}' senza PR. Vedi il log sopra.`);
    return 1;
  } finally {
    if (pg) {
      if (keep && process.env.SMOKE_DATABASE_URL) {
        // Con DB esterno + --keep lasciamo i dati per l'ispezione.
        await pg.handle.client.end();
      } else {
        await pg.stop();
      }
    }
    if (keep) {
      log(`--keep: tmpdir conservata in ${root}`);
    } else {
      while (cleanups.length > 0) await cleanups.pop()?.();
    }
  }
}

/* ------------------------------------------------------------------ *
 * MODALITÀ REMOTE
 * ------------------------------------------------------------------ */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[smoke] variabile mancante per --remote: ${name}`);
    console.error(
      "[smoke] --remote richiede: SMOKE_DATABASE_URL, SMOKE_ENCRYPTION_KEY, SMOKE_PROJECT_SLUG " +
        "(e opzionalmente SMOKE_TICKET_NUMBER).",
    );
    process.exit(2);
  }
  return value;
}

async function runRemote(keep: boolean): Promise<number> {
  section("SMOKE — MODALITÀ REMOTE (pipeline COMPLETAMENTE reale, apre una PR VERA)");

  const status = await checkClaude();
  if (status === "missing") {
    log("`claude` non disponibile sul PATH: smoke saltato.");
    return 0;
  }
  if (status === "unauthenticated") {
    log("`claude` presente ma NON autenticato per l'uso headless (`claude -p`): smoke saltato.");
    return 0;
  }

  const databaseUrl = requireEnv("SMOKE_DATABASE_URL");
  const encryptionKeyB64 = requireEnv("SMOKE_ENCRYPTION_KEY");
  const projectSlug = requireEnv("SMOKE_PROJECT_SLUG");
  const encryptionKey = Buffer.from(encryptionKeyB64, "base64");
  if (encryptionKey.length !== 32) {
    console.error("[smoke] SMOKE_ENCRYPTION_KEY deve essere 32 byte in base64.");
    process.exit(2);
  }

  const handle = createDb(databaseUrl);
  const db = handle.db;
  const root = await mkdtemp(join(tmpdir(), "stubwise-smoke-remote-"));

  try {
    const [project] = await db.select().from(projects).where(eq(projects.slug, projectSlug));
    if (!project) {
      console.error(`[smoke] progetto con slug '${projectSlug}' non trovato nel DB.`);
      return 2;
    }
    log(`progetto: ${project.name} (${project.provider}, ${project.repoUrl})`);

    // Ticket: esistente (SMOKE_TICKET_NUMBER) o creato al volo.
    let ticketId: string;
    let ticketNumber: number;
    const wantedNumber = process.env.SMOKE_TICKET_NUMBER
      ? Number(process.env.SMOKE_TICKET_NUMBER)
      : null;

    if (wantedNumber !== null) {
      const [existing] = await db
        .select()
        .from(tickets)
        .where(and(eq(tickets.projectId, project.id), eq(tickets.number, wantedNumber)));
      if (!existing) {
        console.error(`[smoke] ticket #${wantedNumber} non trovato nel progetto.`);
        return 2;
      }
      ticketId = existing.id;
      ticketNumber = existing.number;
      log(`uso il ticket esistente #${ticketNumber}: ${existing.title}`);
    } else {
      // Numero ticket sequenziale per-progetto, in transazione (come il server).
      const created = await db.transaction(async (tx) => {
        const [p] = await tx
          .select({ next: projects.nextTicketNumber })
          .from(projects)
          .where(eq(projects.id, project.id))
          .for("update");
        const number = p?.next ?? 1;
        await tx
          .update(projects)
          .set({ nextTicketNumber: number + 1 })
          .where(eq(projects.id, project.id));
        const [t] = await tx
          .insert(tickets)
          .values({
            projectId: project.id,
            number,
            title: process.env.SMOKE_TICKET_TITLE ?? "Smoke test: ticket di prova della pipeline",
            body:
              process.env.SMOKE_TICKET_BODY ??
              "Ticket creato dallo smoke test (--remote) per verificare la pipeline end-to-end. " +
                "Se non descrive un bug reale del repo, il triage dovrebbe deciderne lo skip.",
            type: "bug",
            priority: "medium",
            source: "manual",
          })
          .returning();
        return t;
      });
      if (!created) throw new Error("insert del ticket non ha restituito la riga");
      ticketId = created.id;
      ticketNumber = created.number;
      log(`creato ticket di prova #${ticketNumber}`);
    }

    const [job] = await db.insert(aiJobs).values({ ticketId }).returning();
    if (!job) throw new Error("insert del job non ha restituito la riga");

    const mirrors = new MirrorManager({ mirrorsDir: join(root, "mirrors") });
    const handler = createHandler({
      db,
      runner: new ClaudeCliRunner(),
      mirrors,
      encryptionKey,
      // Provider REALE: apertura PR vera.
      getProviderFn: getProvider,
    });

    const claimed = await claimNextJob(db);
    if (!claimed || claimed.id !== job.id) {
      // Un worker reale potrebbe aver reclamato il nostro job (o un altro).
      log("attenzione: il job reclamato non è quello appena creato (un worker è attivo?).");
    }
    const toRun = claimed ?? job;

    section("ESECUZIONE PIPELINE REALE (clone dal provider, apertura PR vera)");
    const startedAt = Date.now();
    await handler(toRun);
    log(`pipeline conclusa in ${Math.round((Date.now() - startedAt) / 1000)}s`);

    await reportOutcome(db, toRun.id, ticketId);

    const [finalJob] = await db.select().from(aiJobs).where(eq(aiJobs.id, toRun.id));
    if (finalJob?.status === "pr_opened") {
      section(`SMOKE OK — PR VERA aperta: ${finalJob.prUrl}`);
      return 0;
    }
    section(`SMOKE — job terminato '${finalJob?.status}'. Vedi il log sopra.`);
    return finalJob?.status === "skipped" ? 0 : 1;
  } finally {
    await handle.client.end();
    if (keep) log(`--keep: tmpdir conservata in ${root}`);
    else await rm(root, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  return args.mode === "remote" ? runRemote(args.keep) : runLocal(args.keep);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[smoke] errore non gestito:");
    console.error(err);
    process.exit(1);
  });
