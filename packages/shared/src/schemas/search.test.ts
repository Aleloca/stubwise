import { describe, expect, it } from "vitest";
import { searchMailHitSchema, searchResultsSchema } from "./search.js";

/**
 * Lo schema dei risultati di ricerca, e la compatibilità verso l'app.
 *
 * ⚠️ **Le fixture qui sotto sono VOLUTAMENTE senza `to` e `cc`** (16 set
 * 2026): sono la risposta di un server più vecchio a un'app appena
 * aggiornata — un rollback, o un'istanza self-hosted non aggiornata. L'app si
 * aggiorna dagli store, quindi quel disallineamento dura settimane, ed è la
 * ragione per cui ogni campo nuovo in una risposta che l'app legge nasce
 * `.default()` e mai obbligatorio (CLAUDE.md, «solo cambi additivi»).
 *
 * Chi "sistema" queste fixture aggiungendo i campi toglie la prova che la
 * difesa c'è.
 */

/** Come la manda un server PRIMA del 16 set 2026: niente `to`, niente `cc`. */
const HIT_FROM_OLD_SERVER = {
  threadId: "thread-1",
  accountId: "acc-1",
  accountEmail: "mailbox@acme.test",
  subject: "Hays | PHP Developer",
  from: "lavinia.corsi@hays.com",
  snippet: "candidato con 7 anni",
  matchedMessageId: "msg-9",
  receivedAt: "2026-09-15T09:00:00.000Z",
};

describe("searchMailHitSchema — `to` e `cc`", () => {
  it("una risposta SENZA i due campi parsa, e dà due array vuoti", () => {
    const parsed = searchMailHitSchema.parse(HIT_FROM_OLD_SERVER);
    expect(parsed.to).toEqual([]);
    expect(parsed.cc).toEqual([]);
  });

  it("quando ci sono, arrivano come sono", () => {
    const parsed = searchMailHitSchema.parse({
      ...HIT_FROM_OLD_SERVER,
      to: ["a.locatelli@thecove.it"],
      cc: ["m.misseri@thecove.it", "g.rossi@acme.test"],
    });
    expect(parsed.to).toEqual(["a.locatelli@thecove.it"]);
    expect(parsed.cc).toHaveLength(2);
  });

  it("il resto del hit resta obbligatorio: i default non sono un lasciapassare", () => {
    const withoutThreadId: Record<string, unknown> = { ...HIT_FROM_OLD_SERVER };
    delete withoutThreadId.threadId;
    expect(() => searchMailHitSchema.parse(withoutThreadId)).toThrow();
  });
});

describe("searchResultsSchema", () => {
  it("una risposta senza il gruppo `mail` parsa (server precedente al 15 set)", () => {
    const parsed = searchResultsSchema.parse({
      tickets: { items: [], hasMore: false },
      projects: { items: [], hasMore: false },
      repositories: { items: [], hasMore: false },
      docs: { items: [], hasMore: false },
    });
    expect(parsed.mail).toEqual({ items: [], hasMore: false });
  });

  it("un gruppo `mail` con un hit di un server vecchio parsa fino in fondo", () => {
    const parsed = searchResultsSchema.parse({
      tickets: { items: [], hasMore: false },
      projects: { items: [], hasMore: false },
      repositories: { items: [], hasMore: false },
      docs: { items: [], hasMore: false },
      mail: { items: [HIT_FROM_OLD_SERVER], hasMore: false },
    });
    expect(parsed.mail.items[0]!.cc).toEqual([]);
  });
});
