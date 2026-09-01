import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkerConfig } from "../config.js";
import {
  ASK_USER_FILENAME,
  ASK_USER_TOOL_PATTERN,
  askUserServerPath,
  buildAskUserRunConfig,
  planParentDir,
  readAskUserQuestion,
} from "./ask-user.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ask-user-bridge-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe("askUserServerPath", () => {
  it("punta all'entry ask-user-mcp SORELLA del modulo, così il layout del dist regge", () => {
    const resolved = askUserServerPath();
    expect(basename(resolved)).toBe("index.js");
    expect(basename(dirname(resolved))).toBe("ask-user-mcp");
    // `tsc` riproduce sotto dist/ l'albero di src/: se in src l'entry sta
    // ESATTAMENTE in quella posizione relativa (../ask-user-mcp/index.ts
    // rispetto a questo modulo), allora nel dist ci sarà il .js omologo — che
    // è il path che il worker in produzione passa a `node`. Questo è il test
    // che protegge dal fallimento SILENZIOSO (tool assente, nessun errore).
    const sourceEntry = resolved.replace(/index\.js$/, "index.ts");
    expect(existsSync(sourceEntry)).toBe(true);
  });

  it("il pattern di allowlist del tool segue la convenzione mcp__<server>__<tool>", () => {
    expect(ASK_USER_TOOL_PATTERN).toBe("mcp__stubwise_ask__ask_user");
  });
});

describe("planParentDir", () => {
  it("è deterministica per job (la ripresa deve ritrovare la stessa cwd)", () => {
    const jobId = "11111111-2222-3333-4444-555555555555";
    expect(planParentDir(jobId)).toBe(planParentDir(jobId));
    expect(basename(planParentDir(jobId))).toBe(`stubwise-plan-${jobId}`);
    expect(planParentDir("altro")).not.toBe(planParentDir(jobId));
  });
});

describe("buildAskUserRunConfig — la env AGENT_QUESTION_MAX_ROUNDS arriva al server MCP", () => {
  /** Entry finta del server MCP: senza un file esistente il tool è disattivato. */
  async function fakeEntry(): Promise<string> {
    const dir = await makeDir();
    const entry = join(dir, "index.js");
    await writeFile(entry, "// entry finta");
    return entry;
  }

  it("il valore della config del worker diventa ASK_USER_MAX_ROUNDS del server MCP", async () => {
    // Catena completa del cablaggio: env del container → loadWorkerConfig →
    // (index.ts) FixDeps.questionMaxRounds → env del processo MCP. L'anello che
    // resta fuori è la riga di index.ts, che è tipizzata (HandlerDeps.fix).
    const config = loadWorkerConfig({
      DATABASE_URL: "postgres://user:pass@localhost:5432/stubwise",
      ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      AGENT_QUESTION_MAX_ROUNDS: "2",
    });
    const run = buildAskUserRunConfig({
      jobId: "11111111-2222-3333-4444-555555555555",
      serverPath: await fakeEntry(),
      round: 1,
      maxRounds: config.agentQuestionMaxRounds,
    });

    expect(run.enabled).toBe(true);
    expect(run.mcpOpt).toEqual({
      mcpConfig: {
        servers: {
          stubwise_ask: {
            command: process.execPath,
            args: [expect.any(String)],
            env: {
              ASK_USER_FILE: join(run.parentDir, ASK_USER_FILENAME),
              ASK_USER_ROUND: "1",
              ASK_USER_MAX_ROUNDS: "2",
            },
          },
        },
      },
    });
    // Anche il prompt annuncia il tetto: l'agente sa quante domande gli restano.
    expect(run.promptOpt).toEqual({ askUser: { round: 1, maxRounds: 2 } });
  });
});

describe("readAskUserQuestion", () => {
  const valid = {
    question: "Rendiamo la cache persistente?",
    options: [
      { label: "In memoria", consequence: "Si perde al riavvio" },
      { label: "Su Postgres" },
    ],
    recommendedIndex: 1,
    allowFreeText: true,
  };

  it("file assente → nessuna domanda, nessun warning", async () => {
    const dir = await makeDir();
    expect(await readAskUserQuestion(join(dir, ASK_USER_FILENAME))).toEqual({ kind: "absent" });
  });

  it("file valido → payload rivalidato con lo schema del tool", async () => {
    const dir = await makeDir();
    const path = join(dir, ASK_USER_FILENAME);
    await writeFile(path, JSON.stringify(valid));

    const result = await readAskUserQuestion(path);

    expect(result.kind).toBe("question");
    if (result.kind !== "question") throw new Error("atteso kind question");
    expect(result.payload.question).toBe("Rendiamo la cache persistente?");
    expect(result.payload.options).toHaveLength(2);
    expect(result.payload.recommendedIndex).toBe(1);
    expect(result.payload.allowFreeText).toBe(true);
  });

  it("recommendedIndex OMESSO (JSON.stringify scarta gli undefined) resta valido e assente", async () => {
    const dir = await makeDir();
    const path = join(dir, ASK_USER_FILENAME);
    await writeFile(path, JSON.stringify({ ...valid, recommendedIndex: undefined }));

    const result = await readAskUserQuestion(path);

    expect(result.kind).toBe("question");
    if (result.kind !== "question") throw new Error("atteso kind question");
    expect(result.payload.recommendedIndex).toBeUndefined();
  });

  it("JSON non parsabile → malformed con motivo, MAI un throw", async () => {
    const dir = await makeDir();
    const path = join(dir, ASK_USER_FILENAME);
    await writeFile(path, "{ non è json");

    const result = await readAskUserQuestion(path);

    expect(result.kind).toBe("malformed");
    if (result.kind !== "malformed") throw new Error("atteso kind malformed");
    expect(result.reason).toBeTruthy();
  });

  it("JSON valido ma fuori schema (una sola opzione) → malformed con le issue zod", async () => {
    const dir = await makeDir();
    const path = join(dir, ASK_USER_FILENAME);
    await writeFile(path, JSON.stringify({ ...valid, options: [{ label: "Unica" }] }));

    const result = await readAskUserQuestion(path);

    expect(result.kind).toBe("malformed");
    if (result.kind !== "malformed") throw new Error("atteso kind malformed");
    expect(result.reason).toMatch(/options/);
  });

  it("recommendedIndex fuori dal range delle opzioni → malformed (il refine dello schema)", async () => {
    const dir = await makeDir();
    const path = join(dir, ASK_USER_FILENAME);
    await writeFile(path, JSON.stringify({ ...valid, recommendedIndex: 7 }));

    const result = await readAskUserQuestion(path);

    expect(result.kind).toBe("malformed");
    if (result.kind !== "malformed") throw new Error("atteso kind malformed");
    expect(result.reason).toMatch(/recommendedIndex/);
  });
});
