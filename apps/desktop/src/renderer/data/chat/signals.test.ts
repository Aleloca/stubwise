import { beforeEach, describe, expect, it } from "vitest";
import { chat, listNotifications, resetApi, setLatency } from "../api";
import { setSessionPersonId } from "../session";
import { now, state } from "../store";

// Task 8: il punto della Chat sul binario e le domande in «Da decidere».
// Il punto si accende solo per ciò che è rivolto a te (menzione diretta,
// DM, thread che segui con risposte nuove), mai per il traffico normale.

const as = (personId: string) => setSessionPersonId(personId);

/** Tutto letto per la persona, fino ad «adesso» (i messaggi nuovi vengono dopo). */
function readEverything(personId: string): void {
  for (const r of state.chatReads.values()) {
    if (r.personId !== personId) continue;
    r.lastReadAt = now();
    for (const root of Object.keys(r.threadReads)) r.threadReads[root] = now();
  }
}

beforeEach(() => {
  setLatency(0);
  resetApi();
});

describe("chat: il punto del binario", () => {
  it("il seme accende il punto per chi ha menzioni dirette, DM o thread con novità", async () => {
    for (const id of ["p-giulia", "p-marco", "p-laura", "p-sara", "p-matteo", "p-roberta"]) {
      as(id);
      expect(await chat.hasNews(), id).toBe(true);
    }
  });

  it("i messaggi normali di un canale non lo accendono; una menzione diretta sì", async () => {
    readEverything("p-giulia");
    as("p-giulia");
    expect(await chat.hasNews()).toBe(false);
    as("p-marco");
    await chat.sendMessage("ch-stw-desktop", { text: "Build is green" });
    await chat.sendMessage("ch-stw-desktop", { text: "@channel standup moved" });
    as("p-giulia");
    // Non letti sì (la colonna li mostra), ma nessun punto sul binario.
    const row = (await chat.listChannels()).find((r) => r.id === "ch-stw-desktop")!;
    expect(row.unread).toBe(2);
    expect(await chat.hasNews()).toBe(false);
    as("p-marco");
    await chat.sendMessage("ch-stw-desktop", { text: "@Giulia Ferri can you look?" });
    as("p-giulia");
    expect(await chat.hasNews()).toBe(true);
    await chat.markRead("ch-stw-desktop");
    expect(await chat.hasNews()).toBe(false);
  });

  it("un DM non letto lo accende, salvo silenziato", async () => {
    readEverything("p-giulia");
    as("p-marco");
    await chat.sendMessage("dm-giulia-marco", { text: "lunch?" });
    as("p-giulia");
    expect(await chat.hasNews()).toBe(true);
    await chat.setNotifyLevel("dm-giulia-marco", "muted");
    expect(await chat.hasNews()).toBe(false);
  });

  it("un thread seguito con risposte nuove lo accende", async () => {
    readEverything("p-giulia");
    as("p-giulia");
    const root = await chat.sendMessage("ch-stw-desktop", { text: "Release notes draft" });
    readEverything("p-giulia");
    expect(await chat.hasNews()).toBe(false);
    as("p-laura");
    await chat.sendMessage("ch-stw-desktop", { text: "Looks good", threadOf: root.id });
    as("p-giulia");
    expect(await chat.hasNews()).toBe(true);
    await chat.markThreadRead(root.id);
    expect(await chat.hasNews()).toBe(false);
  });

  it("silenziato: @channel non lo accende, una menzione diretta sì", async () => {
    readEverything("p-giulia");
    as("p-giulia");
    await chat.setNotifyLevel("ch-mkx-grafica", "muted");
    as("p-chiara");
    await chat.sendMessage("ch-mkx-grafica", { text: "@channel new palette" });
    as("p-giulia");
    expect(await chat.hasNews()).toBe(false);
    as("p-chiara");
    await chat.sendMessage("ch-mkx-grafica", { text: "@Giulia Ferri the photo is in" });
    as("p-giulia");
    expect(await chat.hasNews()).toBe(true);
  });
});

describe("chat: R-G6 — solo le menzioni dirette avvisano", () => {
  it("@channel e @reparto non creano notifiche nemmeno con «tutti i messaggi», ma contano nel canale", async () => {
    readEverything("p-giulia");
    as("p-giulia");
    const start = (await chat.listChannels()).find((r) => r.id === "ch-mkx-grafica")!;
    expect(start.notifyLevel).toBe("all");
    const notesBefore = (await listNotifications()).filter((n) => n.chatMessageId).length;
    as("p-chiara");
    const all = await chat.sendMessage("ch-mkx-grafica", { text: "@channel new palette" });
    const dept = await chat.sendMessage("ch-mkx-grafica", { text: "@Marketing please look" });
    as("p-giulia");
    const notes = (await listNotifications()).filter((n) => n.chatMessageId);
    expect(notes.length).toBe(notesBefore);
    expect(notes.some((n) => n.chatMessageId === all.id || n.chatMessageId === dept.id)).toBe(
      false,
    );
    const row = (await chat.listChannels()).find((r) => r.id === "ch-mkx-grafica")!;
    expect(row.mentions).toBe(2);
    // …e non accendono il punto del binario.
    expect(await chat.hasNews()).toBe(false);
    as("p-chiara");
    const direct = await chat.sendMessage("ch-mkx-grafica", { text: "@Giulia Ferri yours" });
    as("p-giulia");
    expect((await listNotifications()).some((n) => n.chatMessageId === direct.id)).toBe(true);
  });

  it("un thread seguito in un canale archiviato non accende il punto", async () => {
    readEverything("p-giulia");
    as("p-giulia");
    const root = await chat.sendMessage("ch-stw-desktop", { text: "Release notes draft" });
    as("p-laura");
    await chat.sendMessage("ch-stw-desktop", { text: "Looks good", threadOf: root.id });
    as("p-giulia");
    expect(await chat.hasNews()).toBe(true);
    state.channels.find((c) => c.id === "ch-stw-desktop")!.archived = true;
    expect(await chat.hasNews()).toBe(false);
  });
});

describe("chat: notifiche di menzione, solo se leggibili", () => {
  it("chi non legge il canale quando nasce la menzione non riceve nulla, nemmeno dopo", async () => {
    as("p-laura");
    const m = await chat.sendMessage("ch-aud-pricing", {
      text: "@Marco Bellini do you agree on the price list?",
    });
    as("p-marco");
    expect((await listNotifications()).some((n) => n.chatMessageId === m.id)).toBe(false);
    expect((await chat.listQuestions()).some((q) => q.messageId === m.id)).toBe(false);
    as("p-laura");
    await chat.inviteMembers("ch-aud-pricing", ["p-marco"]);
    as("p-marco");
    // Ora legge il canale, ma la notifica non è nata allora: non compare.
    expect((await listNotifications()).some((n) => n.chatMessageId === m.id)).toBe(false);
  });

  it("le domande portano il nome del canale come lo legge chi guarda", async () => {
    as("p-marco");
    await chat.sendMessage("dm-giulia-marco", { text: "@Giulia Ferri ready for the demo?" });
    as("p-giulia");
    const q = (await chat.listQuestions()).find((x) => x.channelId === "dm-giulia-marco")!;
    expect(q.channelLabel).toBe("Marco Bellini");
    const seeded = (await chat.listQuestions()).find((x) => x.channelId === "ch-mkx-grafica");
    expect(seeded?.channelLabel).toBe("MKX · grafica");
  });
});

describe("chat: notifiche del seme", () => {
  it("le menzioni dirette non lette del seme sono già fra le notifiche, e solo quelle", async () => {
    for (const id of ["p-giulia", "p-marco", "p-laura", "p-sara", "p-matteo", "p-roberta"]) {
      as(id);
      const chatNotes = (await listNotifications()).filter((n) => n.chatMessageId);
      for (const n of chatNotes) {
        expect(n.read).toBe(false);
        expect(n.title).toMatch(/(mentioned|asked) you in /);
        expect(n.link).toMatch(/^#\/chat\//);
      }
    }
    as("p-giulia");
    expect((await listNotifications()).some((n) => n.chatMessageId)).toBe(true);
    // Roberta non legge il privato AUD: nessuna notifica da lì, per nessuno che non lo legga.
    as("p-roberta");
    for (const n of (await listNotifications()).filter((x) => x.chatMessageId)) {
      expect(n.link).not.toContain("ch-aud-pricing");
    }
  });
});
