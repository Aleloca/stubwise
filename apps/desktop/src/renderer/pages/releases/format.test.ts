import { describe, expect, it } from "vitest";
import i18n from "../../i18n";
import type { OpenPrView, ReleaseView } from "../../data/releases";
import { notReadyReason, nowSentence, releaseWord, riskWord } from "./format";

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

describe("le PR della build app: i fatti che il server non legge (area 8, F1)", () => {
  const pr = (over: Record<string, unknown>) =>
    ({
      checks: "passing",
      mergeable: true,
      baseBranch: "main",
      analysis: { sha: "a", status: "done", summary: "", risk: "low", issues: [], at: "" },
      prState: { state: "clean", autoRound: 0, canAutoCorrect: false },
      ...over,
    }) as unknown as OpenPrView;
  const t = i18n.getFixedT("en");

  it("senza il rischio (una PR esterna) nessuna parola di rischio", () => {
    expect(
      riskWord(
        pr({ analysis: { sha: "a", status: "done", summary: "", risk: null, issues: [], at: "" } }),
        t,
      ),
    ).toBeNull();
    expect(riskWord(pr({}), t)).toBe("Low risk");
  });

  it("`mergeable` non letto (null) non è un conflitto; `false` sì", () => {
    expect(notReadyReason(pr({ mergeable: null }), t)).toBeNull();
    expect(notReadyReason(pr({ mergeable: false }), t)).toMatch(/main/);
  });
});
