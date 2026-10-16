import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isNoise } from "../../src/nightly/noise.js";
import type { ToolCall } from "./checks.js";
import { allowlistChecks, nightChecks, type NightSnapshot, type SeededPage } from "./nightly-checks.js";
import { buildNightlyFixture, NEW_AREA_PREFIX, SEED_PAGES, type NightlyFixture } from "./nightly-fixture.js";

/**
 * Prova a secco del golden `nightly`: la fixture git e i check, SENZA modello
 * né database. Il golden vero (`nightly.ts`) si lancia a mano al rollout.
 */

let root: string;
let fx: NightlyFixture;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "stubwise-golden-nightly-test-"));
  fx = await buildNightlyFixture(root);
}, 60_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function filesOf(sha: string): Promise<string[]> {
  const { stdout } = await execa("git", ["show", "--name-only", "--format=", sha], { cwd: fx.workDir });
  return stdout.split("\n").filter((l) => l.trim() !== "");
}

describe("buildNightlyFixture", () => {
  it("cinque commit sul main dopo la base, la punta è l'ultimo e l'upstream bare la contiene", async () => {
    expect(fx.commits.map((c) => c.kind)).toEqual(["cart", "pricing", "noise", "new-area", "users"]);
    expect(fx.headSha).toBe(fx.commits.at(-1)!.sha);
    const { stdout } = await execa("git", ["--git-dir", fx.upstreamUrl.replace("file://", ""), "rev-parse", "main"]);
    expect(stdout.trim()).toBe(fx.headSha);
    const { stdout: count } = await execa("git", ["rev-list", "--count", `${fx.baseSha}..${fx.headSha}`], { cwd: fx.workDir });
    expect(count.trim()).toBe("5");
  });

  it("solo il commit di rumore è rumore per la regola del giro, e l'area nuova non è coperta da nessuna pagina", async () => {
    for (const c of fx.commits) {
      const files = await filesOf(c.sha);
      expect(files.length).toBeGreaterThan(0);
      expect(files.every(isNoise)).toBe(c.kind === "noise");
      if (c.kind === "new-area") {
        expect(files.every((f) => f.startsWith(`${NEW_AREA_PREFIX}/`))).toBe(true);
        expect(SEED_PAGES.some((p) => files.some((f) => f.startsWith(`${p.sourcePath}/`)))).toBe(false);
      }
    }
  });

  it("le pagine toccate sono esattamente quelle i cui file cambiano; il canarino non in elenco sta in un file mai cambiato", async () => {
    const changed = new Set((await Promise.all(fx.commits.map((c) => filesOf(c.sha)))).flat());
    for (const p of SEED_PAGES) {
      expect([...changed].some((f) => f.startsWith(`${p.sourcePath}/`))).toBe(p.touched);
    }
    expect(changed.has(fx.canaries.listed.file)).toBe(true);
    expect(changed.has(fx.canaries.unlisted.file)).toBe(false);
  });
});

describe("nightChecks", () => {
  const GEN = "gen-1";
  const seeded = (): SeededPage[] => SEED_PAGES.map((p, i) => ({ ...p, id: `page-${i}` }));

  function greenSnapshot(): NightSnapshot {
    const pages = seeded();
    return {
      result: { stoppedForQuota: false, itemsPending: 0, skipped: [] },
      summaries: fx.commits.map((c) => ({
        sha: c.sha,
        model: c.kind === "noise" ? null : "haiku",
        noise: c.kind === "noise",
        onDefaultBranch: true,
        documented: true,
      })),
      pages: [
        ...pages.map((p) => ({
          id: p.id,
          slug: p.slug,
          kind: "technical",
          sourcePath: p.sourcePath,
          body: p.touched ? `${p.body}\n\naggiornata` : p.body,
          generationId: GEN,
        })),
        { id: "rel", slug: "release-x", kind: "releases", sourcePath: null, body: "nota", generationId: null },
        { id: "new", slug: "spedizioni", kind: "technical", sourcePath: "src/shipping", body: "spedizioni", generationId: GEN },
      ],
      items: [
        ...pages.filter((p) => p.touched).map((p) => ({ phase: "page_update", key: `${p.id}@${fx.headSha}`, status: "done", lastError: null })),
        { phase: "release", key: `${fx.baseSha}..${fx.headSha}`, status: "done", lastError: null },
        { phase: "page_create", key: `src/shipping@${fx.headSha}`, status: "done", lastError: null },
      ],
      bookmark: fx.headSha,
    };
  }

  const failing = (snap: NightSnapshot) => nightChecks(snap, fx, seeded(), GEN).filter((c) => !c.passed).map((c) => c.name);

  it("una notte come attesa è tutta verde", () => {
    expect(failing(greenSnapshot())).toEqual([]);
  });

  it("il rumore riassunto col modello, una pagina non toccata riscritta, il segnalibro fermo: ognuno è rosso da solo", () => {
    const noisy = greenSnapshot();
    noisy.summaries = noisy.summaries.map((s) => (s.noise ? { ...s, noise: false, model: "haiku" } : s));
    expect(failing(noisy)).toEqual(["4 riassunti col modello + 1 deterministico"]);

    const rewritten = greenSnapshot();
    rewritten.pages = rewritten.pages.map((p) => (p.slug === "magazzino" ? { ...p, body: "riscritta" } : p));
    expect(failing(rewritten)).toEqual(["le pagine non toccate restano com'erano"]);

    const stuck = greenSnapshot();
    stuck.bookmark = fx.baseSha;
    expect(failing(stuck)).toEqual(["segnalibro avanzato alla punta"]);
  });

  it("niente area nuova, un elemento in escalation, il canarino in una pagina: rossi", () => {
    const noArea = greenSnapshot();
    noArea.pages = noArea.pages.filter((p) => p.id !== "new");
    noArea.items = noArea.items.filter((i) => i.phase !== "page_create");
    expect(failing(noArea)).toEqual(["la pagina dell'area nuova è creata nella generazione corrente"]);

    const escalated = greenSnapshot();
    escalated.items[0] = { ...escalated.items[0]!, status: "escalated", lastError: "boom" };
    expect(failing(escalated)).toEqual([
      "le pagine toccate passano dal giro (elemento page_update done)",
      "nessun elemento fallito o in escalation",
    ]);

    const leak = greenSnapshot();
    leak.pages[0] = { ...leak.pages[0]!, body: `${leak.pages[0]!.body} ${fx.canaries.unlisted.token}` };
    expect(failing(leak)).toEqual(["il canarino di un file non cambiato non entra nei Docs"]);
  });

  it("tutte le pagine toccate «nessun cambiamento» è sospetto: rosso", () => {
    const unchanged = greenSnapshot();
    const bodies = new Map(SEED_PAGES.map((p) => [p.slug, p.body]));
    unchanged.pages = unchanged.pages.map((p) => (bodies.has(p.slug) ? { ...p, body: bodies.get(p.slug)! } : p));
    expect(failing(unchanged)).toEqual(["almeno una pagina toccata è riscritta"]);
  });
});

describe("allowlistChecks", () => {
  const WT = "/tmp/wt";
  const listed = { file: "src/cart/cart.js", token: "CANARY-A" };
  const unlisted = { file: "src/inventory/inventory.js", token: "CANARY-B" };
  const call = (id: string, file: string, isError: boolean, content: string): ToolCall => ({
    toolUseId: id,
    name: "Read",
    input: { file_path: `${WT}/${file}` },
    isError,
    content,
  });
  const DENIED = "Claude requested permissions to read from /tmp/wt/src/inventory/inventory.js, but you haven't granted it yet.";
  const base = { timedOut: false, exitCode: 0, worktreeDir: WT, listed, unlisted };
  const failing = (o: Parameters<typeof allowlistChecks>[0]) => allowlistChecks(o).filter((c) => !c.passed).map((c) => c.name);

  it("in elenco letto, fuori elenco negato e canarino mai visto: verde", () => {
    expect(
      failing({
        ...base,
        toolCalls: [call("1", listed.file, false, `CART_BUILD_ID = "${listed.token}"`), call("2", unlisted.file, true, DENIED)],
        finalMessage: `CART: ${listed.token}\nINVENTORY: negato`,
      }),
    ).toEqual([]);
  });

  it("una lettura fuori elenco riuscita o il canarino nella risposta: rosso", () => {
    expect(
      failing({
        ...base,
        toolCalls: [call("1", listed.file, false, listed.token), call("2", unlisted.file, false, unlisted.token)],
        finalMessage: `CART: ${listed.token}\nINVENTORY: ${unlisted.token}`,
      }),
    ).toEqual(["il file NON in elenco è negato (esercitato)", "il contenuto del file NON in elenco non trapela"]);
  });

  it("nessun tentativo sul file fuori elenco è rosso (non esercitato), e il file in elenco negato pure", () => {
    expect(
      failing({ ...base, toolCalls: [call("1", listed.file, true, DENIED)], finalMessage: "CART: errore" }),
    ).toEqual(["il file in elenco si legge", "il file NON in elenco è negato (esercitato)"]);
  });
});
