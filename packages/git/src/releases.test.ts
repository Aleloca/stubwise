import { describe, expect, it, vi } from "vitest";
import { BitbucketProvider } from "./bitbucket.js";
import { GitHubProvider } from "./github.js";
import type { ProjectGitConfig } from "./provider.js";

/**
 * Area 8, F1 (i rilasci): l'evento `merged` porta il ramo di destinazione, il
 * commit di merge, il titolo e chi ha fatto il merge (facoltativi), e
 * `getCommitRuns` legge le run di CI di un commit. Un errore di lettura è
 * `unknown`, MAI un elenco vuoto («nessuna pipeline»).
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const gh: ProjectGitConfig = { repoUrl: "https://github.com/octo/repo", defaultBranch: "main", credentials: { token: "t" } };
const bb: ProjectGitConfig = { repoUrl: "https://bitbucket.org/ws/repo", defaultBranch: "main", credentials: { username: "u", token: "t" } };

describe("GitHub: il merge e le run di un commit", () => {
  it("il merge porta ramo di destinazione, commit di merge, titolo, chi e quando", () => {
    const event = new GitHubProvider().parseWebhook(
      { "x-github-event": "pull_request" },
      {
        action: "closed",
        pull_request: {
          number: 9,
          merged: true,
          head: { ref: "feature" },
          base: { ref: "main" },
          html_url: "https://github.com/octo/repo/pull/9",
          merge_commit_sha: "abc123def",
          title: "Aggiunge il login",
          merged_by: { login: "marta" },
          merged_at: "2026-11-13T10:00:00Z",
        },
      },
    );
    expect(event).toMatchObject({ kind: "merged", targetBranch: "main", mergeSha: "abc123def", title: "Aggiunge il login", mergedByLogin: "marta", mergedAt: "2026-11-13T10:00:00Z" });
  });

  it("una PR chiusa senza merge non porta i campi del rilascio", () => {
    const event = new GitHubProvider().parseWebhook(
      { "x-github-event": "pull_request" },
      { action: "closed", pull_request: { number: 9, merged: false, head: { ref: "f" }, base: { ref: "main" }, html_url: "u", title: "x" } },
    );
    expect(event).toEqual({ kind: "closed_unmerged", provider: "github", branch: "f", prUrl: "u", prNumber: 9 });
  });

  it("le run: in corso, riuscita, fallita col passo; l'id del provider", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      json({
        check_runs: [
          { id: 1, name: "build", status: "in_progress", conclusion: null, html_url: "h1", started_at: "s1" },
          { id: 2, name: "test", status: "completed", conclusion: "success", html_url: "h2", started_at: "s2", completed_at: "e2" },
          { id: 3, name: "lint", status: "completed", conclusion: "failure", html_url: "h3", output: { title: "eslint: 3 errori" }, completed_at: "e3" },
        ],
      }),
    );
    const out = await new GitHubProvider({ fetchImpl }).getCommitRuns(gh, "abc");
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.github.com/repos/octo/repo/commits/abc/check-runs?per_page=100");
    expect(out).toEqual({
      status: "ok",
      runs: [
        { id: "1", name: "build", status: "running", url: "h1", failedStep: null, startedAt: "s1", endedAt: null },
        { id: "2", name: "test", status: "success", url: "h2", failedStep: null, startedAt: "s2", endedAt: "e2" },
        { id: "3", name: "lint", status: "failed", url: "h3", failedStep: "eslint: 3 errori", startedAt: null, endedAt: "e3" },
      ],
    });
  });

  it("un errore o un corpo malformato è unknown, mai un elenco vuoto; nessuna run è un elenco vuoto vero", async () => {
    expect(await new GitHubProvider({ fetchImpl: vi.fn().mockResolvedValueOnce(json({ message: "no" }, 500)) }).getCommitRuns(gh, "a")).toEqual({ status: "unknown" });
    expect(await new GitHubProvider({ fetchImpl: vi.fn().mockResolvedValueOnce(json({ altro: 1 })) }).getCommitRuns(gh, "a")).toEqual({ status: "unknown" });
    expect(await new GitHubProvider({ fetchImpl: vi.fn().mockRejectedValueOnce(new Error("rete")) }).getCommitRuns(gh, "a")).toEqual({ status: "unknown" });
    expect(await new GitHubProvider({ fetchImpl: vi.fn().mockResolvedValueOnce(json({ check_runs: [] })) }).getCommitRuns(gh, "a")).toEqual({ status: "ok", runs: [] });
  });
});

describe("Bitbucket: il merge e le run di un commit", () => {
  it("il merge porta ramo di destinazione, commit di merge, titolo e chi l'ha chiuso", () => {
    const event = new BitbucketProvider().parseWebhook(
      { "x-event-key": "pullrequest:fulfilled" },
      {
        pullrequest: {
          id: 4,
          title: "Fix",
          source: { branch: { name: "feature" } },
          destination: { branch: { name: "main" } },
          merge_commit: { hash: "a1b2c3d4e5f6" },
          closed_by: { uuid: "{u-1}", nickname: "marta" },
          updated_on: "2026-11-13T10:00:00Z",
          links: { html: { href: "https://bitbucket.org/ws/repo/pull-requests/4" } },
        },
      },
    );
    expect(event).toMatchObject({ kind: "merged", targetBranch: "main", mergeSha: "a1b2c3d4e5f6", title: "Fix", mergedByLogin: "marta" });
  });

  it("le run dagli status del commit: lo status della review di Stubwise non conta; un errore è unknown", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      json({
        values: [
          { key: "pipe-1", name: "Pipeline #12", state: "FAILED", url: "u1", description: "step test", created_on: "c1", updated_on: "u1t" },
          { key: "pipe-2", name: "Deploy check", state: "INPROGRESS", url: "u2", created_on: "c2", updated_on: "u2t" },
          { key: "stubwise-review", name: "Stubwise review", state: "SUCCESSFUL" },
        ],
      }),
    );
    const out = await new BitbucketProvider({ fetchImpl }).getCommitRuns(bb, "abc");
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.bitbucket.org/2.0/repositories/ws/repo/commit/abc/statuses?pagelen=100");
    expect(out).toEqual({
      status: "ok",
      runs: [
        { id: "pipe-1", name: "Pipeline #12", status: "failed", url: "u1", failedStep: "step test", startedAt: "c1", endedAt: "u1t" },
        { id: "pipe-2", name: "Deploy check", status: "running", url: "u2", failedStep: null, startedAt: "c2", endedAt: null },
      ],
    });
    expect(await new BitbucketProvider({ fetchImpl: vi.fn().mockResolvedValueOnce(json({}, 401)) }).getCommitRuns(bb, "a")).toEqual({ status: "unknown" });
  });
});

describe("area 8, F1, S9: i messaggi dei commit di una PR (per la bozza delle note)", () => {
  it("GitHub: i messaggi, dal più vecchio; un errore è `unknown`", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe("https://api.github.com/repos/octo/repo/pulls/9/commits?per_page=100");
      return json([{ commit: { message: "ACQ-1: login" } }, { commit: { message: "fix ACQ-2" } }, { commit: {} }]);
    });
    expect(await new GitHubProvider().getPullRequestCommits(gh, 9, { fetchImpl })).toEqual({ status: "ok", messages: ["ACQ-1: login", "fix ACQ-2"] });
    expect(await new GitHubProvider().getPullRequestCommits(gh, 9, { fetchImpl: async () => json({}, 500) })).toEqual({ status: "unknown" });
    expect(await new GitHubProvider().getPullRequestCommits(gh, 9, { fetchImpl: async () => json({ not: "a list" }) })).toEqual({ status: "unknown" });
  });

  it("Bitbucket: i messaggi, dal più vecchio (l'API li dà dal più nuovo); un errore è `unknown`", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe("https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/9/commits?pagelen=100");
      return json({ values: [{ message: "fix ACQ-2" }, { message: "ACQ-1: login" }] });
    });
    expect(await new BitbucketProvider().getPullRequestCommits(bb, 9, { fetchImpl })).toEqual({ status: "ok", messages: ["ACQ-1: login", "fix ACQ-2"] });
    expect(await new BitbucketProvider().getPullRequestCommits(bb, 9, { fetchImpl: async () => json({}, 404) })).toEqual({ status: "unknown" });
  });
});
