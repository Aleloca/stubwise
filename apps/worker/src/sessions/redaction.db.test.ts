import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { agentSessionEvents } from "@stubwise/db";
import { StreamingClaudeRunner } from "../agent/streaming-cli.js";
import { SessionInputRelay } from "./relay.js";
import { ensureAgentSession } from "./store.js";

// Finto CLI: risponde con un tool_result che contiene il valore del .env e la
// chiave del provider letta dall'ambiente, poi chiude il turno.
const FAKE = `#!/usr/bin/env node
require("node:readline").createInterface({ input: process.stdin }).once("line", () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  out({ type: "system", subtype: "init", capabilities: [] });
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "cat .env" } }] } });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "DB_PASSWORD=env-value-123456 KEY=" + process.env.ANTHROPIC_API_KEY }] } });
  out({ type: "result", subtype: "success", is_error: false, result: "fatto", total_cost_usd: 0.01, session_id: "s" });
});
`;

let t: TestDb;
let root: string;
beforeAll(async () => {
  t = await startTestDb();
  root = await mkdtemp(join(tmpdir(), "stw-redact-db-"));
  await writeFile(join(root, "claude"), FAKE, "utf8");
  await chmod(join(root, "claude"), 0o755);
}, 120_000);
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await t.stop();
});

describe("oscuramento a livello di database", () => {
  it("né il valore del .env né la chiave del provider arrivano in agent_session_events", async () => {
    const sessionId = (await ensureAgentSession(t.db, { ownerKey: "ai_job:redact", kind: "ai_job", title: "t" }))!;
    const relay = new SessionInputRelay({ db: t.db, pollMs: 60_000, log: () => undefined });
    const runner = new StreamingClaudeRunner({ claudePath: join(root, "claude"), hooks: relay, resultGraceMs: 20 });
    await runner.run({
      cwd: root,
      prompt: "via",
      maxTurns: 3,
      timeoutMs: 10_000,
      provider: { id: "p", kind: "api_key", secret: "sk-ant-provider-secret" },
      session: { sessionId, label: "execute", secrets: ["env-value-123456"] },
    });
    const dump = JSON.stringify(
      await t.db.select().from(agentSessionEvents).where(eq(agentSessionEvents.sessionId, sessionId)),
      // `id` è un bigserial (bigint): JSON.stringify non lo serializza da solo.
      (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
    );
    expect(dump).toContain("tool_result");
    expect(dump).not.toContain("env-value-123456");
    expect(dump).not.toContain("sk-ant-provider-secret");
    expect(dump).toContain("•••");
  });
});
