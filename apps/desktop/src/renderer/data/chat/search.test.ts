import { beforeEach, describe, expect, it } from "vitest";
import { chat, resetApi, setLatency } from "../api";
import { setSessionPersonId } from "../session";
import { state, visibleProjectIds } from "../store";
import type { ChatMessageHit } from "../types";
import { canReadChannel } from "./visibility";

// La ricerca della Chat (Task 7): una sola funzione decide cosa si cerca, e
// la usano la pagina dei risultati e ⌘K. Review Focus 1 e 3 sono qui.

const as = (personId: string) => setSessionPersonId(personId);
const channel = (id: string) => state.channels.find((c) => c.id === id)!;
const ids = (hits: ChatMessageHit[]) => hits.map((h) => h.message.id);
const channelsOf = (hits: ChatMessageHit[]) => [...new Set(hits.map((h) => h.channelId))];

beforeEach(() => {
  setLatency(0);
  resetApi();
});

describe("chat: ricerca", () => {
  it("Review Focus 1: Roberta non trova nulla di un privato in cui non è, né di un DM altrui", async () => {
    as("p-giulia");
    expect(channelsOf(await chat.searchChat("projector"))).toContain("dm-launch-week");
    as("p-laura");
    expect(channelsOf(await chat.searchChat("annual"))).toContain("ch-aud-pricing");

    as("p-roberta");
    for (const q of ["projector", "annual", "launch week", "renewal", "the"]) {
      const hits = await chat.searchChat(q);
      expect(channelsOf(hits)).not.toContain("ch-aud-pricing");
      expect(channelsOf(hits)).not.toContain("dm-launch-week");
      expect(channelsOf(hits)).not.toContain("dm-giulia-marco");
      for (const h of hits) {
        expect(canReadChannel("p-roberta", channel(h.channelId))).toBe(true);
        // Nemmeno il contesto viene da un canale che non legge.
        if (h.context) expect(h.context.channelId).toBe(h.channelId);
      }
    }
    // «In» su un privato non letto o su un DM altrui risponde come un canale che non esiste.
    expect(await chat.searchChat("annual", { channelId: "ch-aud-pricing" })).toEqual([]);
    expect(await chat.searchChat("projector", { channelId: "dm-launch-week" })).toEqual([]);
    expect(await chat.searchChat("projector", { channelId: "ch-does-not-exist" })).toEqual([]);
    // Il conteggio non cambia quando cresce un privato che non legge.
    const before = (await chat.searchChat("the")).length;
    as("p-laura");
    await chat.sendMessage("ch-aud-pricing", { text: "the reseller margin stays private" });
    as("p-roberta");
    expect((await chat.searchChat("the")).length).toBe(before);
  });

  it("senza differenza fra maiuscole e accenti; ogni parola deve esserci", async () => {
    as("p-giulia");
    const m = await chat.sendMessage("ch-stw-desktop", {
      text: "Il caffè è pronto in sala riunioni",
    });
    expect(ids(await chat.searchChat("caffe pronto"))).toContain(m.id);
    expect(ids(await chat.searchChat("CAFFÈ"))).toContain(m.id);
    expect(ids(await chat.searchChat("caffe\u0300"))).toContain(m.id);
    expect(ids(await chat.searchChat("caffe zanzibar"))).not.toContain(m.id);
    // Sotto i 2 caratteri non si cerca.
    expect(await chat.searchChat("c")).toEqual([]);
  });

  it("i filtri: canale, persona, date, allegati, citazioni", async () => {
    as("p-giulia");
    const plain = await chat.sendMessage("ch-stw-desktop", { text: "quokkafilter plain" });
    const withFile = await chat.sendMessage("ch-stw-desktop", {
      text: "quokkafilter file",
      attachments: [{ id: "f-q", name: "quokka-notes.pdf", sizeBytes: 1200, kind: "file" }],
    });
    const visible = visibleProjectIds("p-giulia");
    const task = [...state.tasksById.values()].find((t) => visible.has(t.projectId))!;
    const cited = await chat.sendMessage("ch-stw-desktop", {
      text: `quokkafilter cited ${task.code}`,
      citations: [{ kind: "task", id: task.id }],
    });
    as("p-marco");
    const marco = await chat.sendMessage("ch-stw-desktop", { text: "quokkafilter by marco" });

    expect(ids(await chat.searchChat("quokkafilter"))).toHaveLength(4);
    expect(ids(await chat.searchChat("quokkafilter", { authorId: "p-giulia" })).sort()).toEqual(
      [plain.id, withFile.id, cited.id].sort(),
    );
    expect(ids(await chat.searchChat("quokkafilter", { withAttachments: true }))).toEqual([
      withFile.id,
    ]);
    expect(ids(await chat.searchChat("quokkafilter", { withCitations: true }))).toEqual([cited.id]);
    expect(await chat.searchChat("quokkafilter", { channelId: "ch-aud-general" })).toEqual([]);
    const day = marco.createdAt.slice(0, 10);
    expect(await chat.searchChat("quokkafilter", { to: "2000-01-01" })).toEqual([]);
    expect(ids(await chat.searchChat("quokkafilter", { from: day, to: day }))).toHaveLength(4);
    // Il nome di un allegato si trova come il testo.
    expect(ids(await chat.searchChat("quokka-notes"))).toEqual([withFile.id]);
  });

  it("«Solo persone» toglie i messaggi di sistema", async () => {
    as("p-roberta");
    const system = state.chatMessages.find(
      (m) =>
        m.kind === "system" &&
        m.deletedAt === null &&
        canReadChannel("p-roberta", channel(m.channelId)),
    )!;
    const word = system.text.split(/\s+/).find((w) => /^[A-Za-z]{5,}$/.test(w))!;
    expect(ids(await chat.searchChat(word))).toContain(system.id);
    const people = await chat.searchChat(word, { peopleOnly: true });
    expect(ids(people)).not.toContain(system.id);
    expect(people.every((h) => h.message.kind !== "system")).toBe(true);
  });

  it("Review Focus 3: un eliminato non si trova e non fa da contesto", async () => {
    as("p-giulia");
    const before = await chat.sendMessage("ch-stw-desktop", { text: "first context line" });
    const gone = await chat.sendMessage("ch-stw-desktop", { text: "wombatsecret goes away" });
    const after = await chat.sendMessage("ch-stw-desktop", { text: "numbatquery after it" });
    expect((await chat.searchChat("numbatquery"))[0]?.context?.id).toBe(gone.id);
    await chat.deleteMessage(gone.id);
    expect(await chat.searchChat("wombatsecret")).toEqual([]);
    const [found] = await chat.searchChat("numbatquery");
    expect(found?.message.id).toBe(after.id);
    // Il contesto salta l'eliminato: è il messaggio vivo di prima.
    expect(found?.context?.id).toBe(before.id);
    expect(JSON.stringify(await chat.searchChat("numbatquery"))).not.toContain("wombatsecret");
    expect(JSON.stringify(await chat.searchChat("context"))).not.toContain("wombatsecret");
  });

  it("in un thread il contesto è il messaggio prima nel thread", async () => {
    as("p-giulia");
    const root = await chat.sendMessage("ch-stw-desktop", { text: "root of the dingothread" });
    const reply = await chat.sendMessage("ch-stw-desktop", {
      text: "dingoreply inside",
      threadOf: root.id,
    });
    const [found] = await chat.searchChat("dingoreply");
    expect(found?.message.id).toBe(reply.id);
    expect(found?.message.threadOf).toBe(root.id);
    expect(found?.context?.id).toBe(root.id);
    expect(found?.root?.text).toBe("root of the dingothread");
    // La radice eliminata non porta più il suo testo: né come radice né come contesto.
    await chat.deleteMessage(root.id);
    const [again] = await chat.searchChat("dingoreply");
    expect(again?.root?.text).toBe("");
    expect(again?.context).toBeNull();
    expect(JSON.stringify(again)).not.toContain("dingothread");
  });
});
