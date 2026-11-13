import { describe, expect, it } from "vitest";
import i18n from "../../i18n";
import type { ReleaseView } from "../../data/releases";
import { nowSentence, releaseWord } from "./format";

// Area 8, F1: le run illeggibili (`unknown` di `releaseStatusOf`) si dicono
// come tali, mai come «riuscito» né «non disponibile».

const view = (kind: ReleaseView["status"]["kind"]) =>
  ({
    status: { kind, since: null },
    runs: [],
    projectCode: "AUD",
    pr: { repo: "a/b", number: 1 },
    mergedAt: "2026-11-13T09:00:00Z",
  }) as unknown as ReleaseView;

describe("lo stato «unknown» di un rilascio", () => {
  it("ha la sua parola e la sua frase in «Now»", () => {
    const t = i18n.getFixedT("en");
    expect(releaseWord(view("unknown"), t)).toBe("Status unknown");
    expect(nowSentence(view("unknown"), t, "en")).toBe(
      "The CI runs couldn't be read: the status isn't known for now.",
    );
  });
});
