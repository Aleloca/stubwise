import { describe, expect, it } from "vitest";
import { splitSseFrames } from "../claude/sse.js";
import { isAllowedDocsChatStreamPath, parseDocsChatFrame } from "./docsSse.js";

const SID = "22222222-2222-4222-8222-222222222222";
const REPO = "33333333-3333-4333-8333-333333333333";
const source = { slug: "intro", title: "Intro", kind: "technical", repositoryId: REPO, repositorySlug: "r", repositoryName: "R", code: "ACQ-D1" };
// I frame esattamente come li scrive `writeSseEvent` del server (`data: {json}\n\n`), col ping in mezzo.
const sse = (...events: unknown[]) => events.map((e) => (typeof e === "string" ? e : `data: ${JSON.stringify(e)}\n\n`)).join("");

describe("parseDocsChatFrame (lotto 7, voce 2)", () => {
  it("i delta, il ping scartato, poi `done` con le fonti come la risposta JSON", () => {
    const { frames, rest } = splitSseFrames(
      sse({ type: "delta", text: "Ciao " }, ": ping\n\n", { type: "delta", text: "mondo" }, { type: "done", sessionId: SID, citations: [source], productSources: [{ pageId: REPO, code: "ACQ-P1", title: "Prodotto" }] }),
    );
    expect(rest).toBe("");
    expect(frames.flatMap(parseDocsChatFrame)).toEqual([
      { type: "delta", text: "Ciao " },
      { type: "delta", text: "mondo" },
      { type: "done", sessionId: SID, sources: [source], productSources: [{ pageId: REPO, code: "ACQ-P1", title: "Prodotto" }] },
    ]);
  });

  it("una fonte malformata si scarta senza costare il `done`; un server di prima senza `productSources` dà []", () => {
    const [done] = parseDocsChatFrame(sse({ type: "done", sessionId: SID, citations: [source, { slug: 1 }] }));
    expect(done).toEqual({ type: "done", sessionId: SID, sources: [source], productSources: [] });
  });

  it("`error`, un JSON rotto e un tipo ignoto: solo l'errore", () => {
    expect(parseDocsChatFrame("data: {rotto\n\n")).toEqual([]);
    expect(parseDocsChatFrame(sse({ type: "boh" }, { type: "error", message: "Chat generation failed" }).replace(/\n\n/g, "\n"))).toEqual([{ type: "error", message: "Chat generation failed" }]);
  });

  it("`done` senza un sessionId uuid non è un `done`", () => {
    expect(parseDocsChatFrame(sse({ type: "done", sessionId: "x", citations: [] }))).toEqual([]);
  });

  it("l'allowlist: le due POST con un uuid, nient'altro", () => {
    expect(isAllowedDocsChatStreamPath(`/api/repositories/${REPO}/docs/chat`)).toBe(true);
    expect(isAllowedDocsChatStreamPath(`/api/projects/${REPO}/docs/chat`)).toBe(true);
    expect(isAllowedDocsChatStreamPath(`/api/projects/${REPO}/docs/chat?stream=false`)).toBe(false);
    expect(isAllowedDocsChatStreamPath(`/api/backlog/${REPO}/docs/chat`)).toBe(false);
    expect(isAllowedDocsChatStreamPath(`/api/projects/x/docs/chat`)).toBe(false);
  });
});
