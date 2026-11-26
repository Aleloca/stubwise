import { beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../api";
import { markReauthenticated } from "../auth/reauth";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import { CLAUDE_CATALOG, reauthOf } from "./catalog";
import { classOf } from "./classes";

// Lotto 10 (72, 555e3ad15): `saveStorage` lo esegue il server. Gli argomenti
// sono una PATCH (`endpoint`, `region`, `bucket`, `accessKeyId`, almeno uno;
// mai la chiave segreta): un campo assente resta com'è. La riconferma la
// chiede SOLO un endpoint o un bucket diversi da quelli salvati; vale anche
// per «Undo».

const ROBERTA = "p-roberta";

beforeEach(() => {
  setLatency(0);
  resetApi();
  setSessionPersonId(ROBERTA);
});

const storage = () => state.instance.storage;

describe("saveStorage: la patch e la riconferma per campo", () => {
  it("C solo con endpoint o bucket diversi da quelli salvati; region e accessKeyId restano B", () => {
    const s = storage();
    const cls = (args: Record<string, unknown>) =>
      classOf(ROBERTA, { fn: "saveStorage", args }).cls;
    expect(cls({ endpoint: s.endpoint, bucket: s.bucket })).toBe("B");
    expect(cls({ region: "eu-south-1" })).toBe("B");
    expect(cls({ accessKeyId: "AKIA-NEW" })).toBe("B");
    expect(cls({ endpoint: "https://s3.other.example" })).toBe("C");
    expect(cls({ bucket: "another-bucket" })).toBe("C");
  });

  it("un campo assente resta com'è; una patch vuota è rifiutata", () => {
    const before = { ...storage() };
    CLAUDE_CATALOG.saveStorage.run(ROBERTA, { region: "eu-south-1" });
    expect(storage()).toMatchObject({
      endpoint: before.endpoint,
      bucket: before.bucket,
      accessKeyId: before.accessKeyId,
      region: "eu-south-1",
    });
    expect(() => CLAUDE_CATALOG.saveStorage.run(ROBERTA, {})).toThrow();
  });

  it("«Undo» di un endpoint cambiato chiede anch'esso la riconferma", () => {
    // La voce gira dopo la conferma di una C, quindi dopo la riconferma.
    markReauthenticated(ROBERTA);
    const run = CLAUDE_CATALOG.saveStorage.run(ROBERTA, { endpoint: "https://s3.other.example" });
    expect(reauthOf("saveStorage", run.inverse!.args)).toBe(true);
  });
});
