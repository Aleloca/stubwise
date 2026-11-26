import { beforeEach, describe, expect, it } from "vitest";
import {
  sendMessage,
  setConversationContexts,
  setLatency,
  setVisibility,
  resetApi,
  whenIdle,
} from "./api";
import { setSessionPersonId } from "./session";
import { state, visibleProjectIds } from "./store";

// Decisione di 46 (24 nov 2026), la regola del server (revisione 8–9, I-1):
// pubblicare conta i progetti di TUTTO il gruppo dei contesti, non solo di
// ciò che Claude ha letto — un chip nomina il suo progetto.

beforeEach(() => {
  setLatency(0);
  resetApi();
  setSessionPersonId("p-giulia");
});

const ID = "cv-giulia-week";
const conv = () => state.conversations.find((c) => c.id === ID)!;

/** Un progetto che Giulia vede e che la conversazione non ha ancora toccato. */
function freshProject(): string {
  const touched = new Set(conv().touchedProjectIds);
  const id = [...visibleProjectIds("p-giulia")].find((p) => !touched.has(p));
  if (!id) throw new Error("nessun progetto libero nel seme");
  return id;
}

const codesOf = (r: Awaited<ReturnType<typeof setVisibility>>) =>
  r.status === "needs_confirmation" ? r.touchedProjects.map((p) => p.id) : [];

describe("pubblicare conta i progetti dei contesti", () => {
  it("un contesto del gruppo (anche non primario) entra nell'elenco da confermare", async () => {
    const extra = freshProject();
    const before = [...conv().touchedProjectIds];
    await setConversationContexts(ID, [
      { kind: "page", route: "overview", projectId: extra },
      { kind: "page", route: "overview", projectId: before[0]! },
    ]);
    const asked = await setVisibility(ID, "public");
    expect(codesOf(asked)).toContain(extra);
    // Confermare senza quel progetto non basta.
    const partial = await setVisibility(ID, "public", { confirmedProjectIds: before });
    expect(partial.status).toBe("needs_confirmation");
    const done = await setVisibility(ID, "public", { confirmedProjectIds: codesOf(asked) });
    expect(done.status).toBe("done");
    expect(conv().publishedProjectIds).toContain(extra);
  });

  it("dopo la pubblicazione un progetto nuovo dal chip trattiene il seguito (privato finché non si riconferma)", async () => {
    const asked = await setVisibility(ID, "public");
    await setVisibility(ID, "public", { confirmedProjectIds: codesOf(asked) });
    expect(conv().privateFromIndex).toBeNull();
    const extra = freshProject();
    await sendMessage(
      ID,
      { text: "Hi" },
      { context: { kind: "page", route: "overview", projectId: extra } },
    );
    await whenIdle(ID);
    expect(conv().touchedProjectIds).toContain(extra);
    expect(conv().privateFromIndex).not.toBeNull();
  });
});
