import { describe, expect, it } from "vitest";
import i18n from "../../i18n";
import type { OpenPrView, ReleaseView } from "../../data/releases";
import {
  githubLink,
  notReadyReason,
  nowSentence,
  platformOf,
  prProse,
  prUrl,
  releaseWord,
  riskWord,
} from "./format";

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

  it("la review dell'istanza spenta: «non analizzata», mai «senza problemi»; il repository spento resta suo", () => {
    const off = { state: "analysis_off", autoRound: 0, canAutoCorrect: false };
    expect(prProse(pr({ prState: off, analysisOff: "instance", repo: "audin/audin-app" }), t)).toBe(
      "Not analyzed: automatic review is off",
    );
    expect(prProse(pr({ prState: off, repo: "audin/audin-app" }), t)).toBe(
      "Analysis is off for audin-app",
    );
  });
});

describe("i link della PR dalla piattaforma vera (review F1, I1)", () => {
  const bb = {
    repo: "audin/app",
    number: 12,
    url: "https://bitbucket.org/audin/app/pull-requests/12",
  };
  const gh = { repo: "audin/app", number: 7, url: "https://github.com/audin/app/pull/7" };

  it("l'indirizzo della PR è quello del server; il prototipo (senza url) costruisce GitHub", () => {
    expect(prUrl(bb)).toBe(bb.url);
    expect(platformOf(prUrl(bb))).toBe("Bitbucket");
    expect(prUrl({ repo: "audin/app", number: 7 })).toBe("https://github.com/audin/app/pull/7");
    expect(prUrl({ repo: "audin/app", number: 0, url: "" })).toBeNull();
  });

  it("commit e file solo su github.com, e mai con lo sha vuoto", () => {
    expect(githubLink(gh, "commit", "abc1234")).toBe("https://github.com/audin/app/commit/abc1234");
    expect(githubLink(bb, "commit", "abc1234")).toBeNull();
    expect(githubLink(gh, "commit", "")).toBeNull();
    expect(githubLink({ repo: "audin/app", number: 7 }, "blob", "abc1234", "src/a.ts")).toBe(
      "https://github.com/audin/app/blob/abc1234/src/a.ts",
    );
  });
});
