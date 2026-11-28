import { beforeEach, describe, expect, it } from "vitest";
import { mail, resetApi, setLatency } from "../api";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import { PEOPLE } from "../seed/people";
import { numberRawRemoteImages } from "./images";
import { canSeeMessage } from "./visibility";

// Le immagini delle email nel prototipo (design
// `docs/plans/2026-11-28-proxy-immagini-posta-design.md`): la numerazione che
// sul server fa `/original`, e una lettura per posizione che restituisce un
// segnaposto (il prototipo non ha rete).

beforeEach(() => {
  setLatency(0);
  resetApi();
});

describe("numberRawRemoteImages", () => {
  it("numera, in ordine, le sole immagini remote; le data: no", () => {
    const html = '<p>x</p><img src="https://a/1.png"><img src="data:image/png;base64,AA"><IMG alt="y" src=\'http://b/2.jpg\'>';
    const out = numberRawRemoteImages(html);
    expect([...out.matchAll(/data-image="(\d+)"/gi)].map((m) => m[1])).toEqual(["0", "1"]);
    expect(numberRawRemoteImages(out)).toBe(out);
  });
});

describe("getMessageImage nel prototipo", () => {
  it("chi vede il messaggio riceve un'immagine data: per una posizione che c'è; fuori elenco o chi non lo vede: null", async () => {
    const message = state.mailMessages.find((m) => m.html?.includes("cdn.fieradigitale.example"))!;
    const reader = message.mailboxPersonIds[0]!;
    setSessionPersonId(reader);
    expect(await mail.getMessageImage(message.id, 0)).toMatch(/^data:image\/png;base64,/);
    expect(await mail.getMessageImage(message.id, 99)).toBeNull();
    const stranger = PEOPLE.find((p) => !canSeeMessage(p.id, message))!;
    setSessionPersonId(stranger.id);
    expect(await mail.getMessageImage(message.id, 0)).toBeNull();
  });
});
