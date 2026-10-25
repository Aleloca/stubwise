import type { GraphCommunity, GraphState } from "../../types";

// Il grafo del codice (graphify) di ogni repository, quando è pronto: i
// conteggi e il resoconto delle comunità, coi nomi scritti dall'AI. STW lo
// ha già; AUD lo ottiene quando qualcuno lo accende («Enable it in the
// repository»); un repository senza voce qui riceve un grafo generico.

type ReadyGraph = Required<Pick<GraphState, "nodes" | "edges" | "communities" | "report">>;

const community = (
  id: string,
  name: string,
  size: number,
  summary: string,
  nodes: string[],
  links: string[],
): GraphCommunity => ({ id, name, size, summary, nodes, links });

export const GRAPHS: Record<string, ReadyGraph> = {
  "repo-stw": {
    nodes: 4812,
    edges: 11930,
    communities: 37,
    report: [
      community(
        "c0",
        "Worker job queue",
        612,
        "Claims jobs with FOR UPDATE SKIP LOCKED and serialises them per project.",
        ["claimNextJob", "projectSerializer", "recoverStaleJobs", "runJob"],
        ["c1", "c2"],
      ),
      community(
        "c1",
        "Fix pipeline",
        548,
        "Plans, runs and repairs a fix on the linked repository, then opens the pull request.",
        ["runFixPipeline", "parkForPlanApproval", "stagePathspecs", "openPullRequest"],
        ["c0", "c3"],
      ),
      community(
        "c2",
        "Docs generation",
        431,
        "The nightly pass: commit summaries, release notes and page updates.",
        ["nightlyRun", "summariseCommit", "writeReleaseNote", "updateDocPage"],
        ["c0", "c4"],
      ),
      community(
        "c3",
        "Pull request reviews",
        377,
        "Signed reviews, correction rounds and the adoption of pull requests opened by others.",
        ["reviewPullRequest", "correctionCycle", "adoptPullRequest"],
        ["c1"],
      ),
      community(
        "c4",
        "Notifications and inbox",
        296,
        "Publishes inbox cards and push notifications, and derives their fields when read.",
        ["publishNotification", "readGoogle", "pushRelayClient"],
        ["c2", "c5"],
      ),
      community(
        "c5",
        "Permissions",
        241,
        "Project permissions computed on the server, route access and the second factor.",
        ["projectPermissionsFor", "routeAccess", "attemptSecondFactor"],
        ["c4"],
      ),
    ],
  },
  "repo-aud": {
    nodes: 2310,
    edges: 5874,
    communities: 21,
    report: [
      community(
        "c0",
        "Dialer",
        402,
        "Places the calls, records the outcome and moves to the next lead.",
        ["DialerSession", "placeCall", "recordOutcome", "nextLead"],
        ["c1", "c2"],
      ),
      community(
        "c1",
        "Callbacks and reminders",
        268,
        "Stores callbacks in UTC and sends the reminders in the workspace timezone.",
        ["scheduleCallback", "reminderJob", "workspaceTimezone"],
        ["c0"],
      ),
      community(
        "c2",
        "Contacts and import",
        233,
        "Imports contacts from CSV and keeps them deduplicated per workspace.",
        ["importContacts", "dedupeContacts", "csvParser"],
        ["c0", "c3"],
      ),
      community(
        "c3",
        "Billing",
        190,
        "Issues invoices and credit notes and sends the billing emails.",
        ["issueInvoice", "creditNote", "billingMailer"],
        ["c2"],
      ),
    ],
  },
};

/** Il grafo pronto di un repository (uno generico se il seme non ne ha uno). */
export function readyGraph(repositoryId: string): ReadyGraph {
  return (
    GRAPHS[repositoryId] ?? {
      nodes: 640,
      edges: 1520,
      communities: 6,
      report: [
        community(
          "c0",
          "Application core",
          220,
          "The main modules of the repository.",
          ["main"],
          [],
        ),
      ],
    }
  );
}
