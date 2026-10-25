import type { DocSpace } from "../../types";
import { daysFromToday } from "../dates";
import { GENERATED_AT } from "../docPages";

// Lo spazio dei Docs di ogni repository: generazione, brief, releases e
// grafo. STW: generato, grafo pronto. AUD: generazione in pausa sul limite
// d'uso, grafo spento. CBV: mai generato, solo pagine manuali.

const at = (days: number, time = "03:00") => `${daysFromToday(-days)}T${time}:00Z`;

export const DOC_SPACES: DocSpace[] = [
  {
    repositoryId: "repo-stw",
    projectId: "prj-stw",
    name: "stubwise",
    generation: {
      status: "succeeded",
      lastAt: at(4),
      commit: GENERATED_AT["repo-stw"]!,
      costUsd: 3.42,
      provider: "Team account",
      reason: null,
    },
    brief: {
      identity:
        "Stubwise is a self-hostable ticketing system with an AI pipeline: a worker takes the tickets, plans and runs the fix on the linked repository and opens the pull request.",
      actors: [
        { name: "Maintainer", description: "Approves plans and merges the pull requests." },
        {
          name: "Operator",
          description: "Opens tickets and starts runs, without approving plans.",
        },
        {
          name: "Collaborator",
          description: "Asks questions and files requests from Claude Code.",
        },
      ],
      surfaces: [
        { name: "Web app", audience: "The whole team" },
        { name: "Mobile app", audience: "Maintainers on the go" },
        { name: "Claude Code plugin", audience: "Developers and collaborators" },
      ],
      glossary: [
        {
          term: "Stalled",
          definition: "A task nobody touched for longer than the project threshold.",
        },
        {
          term: "Nightly run",
          definition: "The worker pass that summarises commits and updates the Docs.",
        },
      ],
      invariants: [
        "Only someone with plans.approve approves a plan.",
        "Stubwise never deploys: merging an open pull request is the boundary.",
      ],
      journeys: [
        {
          name: "From a bug to a pull request",
          steps: ["Open a ticket", "Start a run", "Approve the plan", "Review the pull request"],
        },
      ],
      sources: [
        { label: "Project instructions", path: "CLAUDE.md" },
        { label: "Invariants", path: "docs/invariants" },
      ],
      confidentialFacts: [
        {
          fact: "The push relay keys of the mobile app",
          reason: "Credentials of the publisher identity",
          where: "packages/notifications/src/push/config.ts",
          mustNotAppearAs: "Any key, token or relay secret",
        },
      ],
      excludedPages: [{ title: "Deploy log", reason: "Operations of our own server" }],
    },
    releases: [
      {
        id: "dr-stw-3",
        version: "0.9.0",
        date: daysFromToday(-4),
        text: "Stalled tasks now count a task waiting for an answer to Claude.",
        minor: false,
        pageIds: ["doc-stw-stalled", "doc-stw-stall-service"],
      },
      {
        id: "dr-stw-2",
        version: "0.8.3",
        date: daysFromToday(-11),
        text: "Typos fixed in the notifications guide.",
        minor: true,
        pageIds: ["doc-stw-notifications"],
      },
      {
        id: "dr-stw-1",
        version: "0.8.2",
        date: daysFromToday(-18),
        text: "The worker pipeline page describes the pull request step.",
        minor: false,
        pageIds: ["doc-stw-worker-pipeline"],
      },
    ],
    graph: { status: "ready", nodes: 4812, edges: 11930, communities: 37 },
  },
  {
    repositoryId: "repo-aud",
    projectId: "prj-aud",
    name: "audin-app",
    generation: {
      status: "paused",
      lastAt: at(6),
      commit: GENERATED_AT["repo-aud"]!,
      costUsd: 2.17,
      provider: "Team account",
      reason: "Paused on the usage limit of the provider: it resumes after the reset.",
    },
    brief: {
      identity:
        "Audin 2.0 is the dialer and CRM of the sales team: calls, leads, deals and invoices for each workspace.",
      actors: [
        { name: "Agent", description: "Makes the calls and schedules the follow-ups." },
        { name: "Team lead", description: "Owns the workspace, its numbers and its invoices." },
      ],
      surfaces: [
        { name: "Dialer", audience: "Agents" },
        { name: "Dashboard", audience: "Team leads" },
      ],
      glossary: [
        { term: "Workspace", definition: "One customer company, with its agents and numbers." },
        { term: "Outcome", definition: "How a call ended: answered, voicemail, no answer." },
      ],
      invariants: [
        "Times are stored in UTC and shown in the timezone of the workspace.",
        "An invoice is never changed once issued: a correction is a credit note.",
      ],
      journeys: [
        {
          name: "A day of calls",
          steps: ["Open the dialer", "Call the next lead", "Record the outcome"],
        },
      ],
      sources: [{ label: "Product notes", path: "docs/product.md" }],
      confidentialFacts: [
        {
          fact: "The pricing of the telephony provider",
          reason: "Commercial agreement",
          where: "src/billing/rates.ts",
          mustNotAppearAs: "Per-minute rates or totals",
        },
      ],
      excludedPages: [{ title: "Internal admin tools", reason: "Not for customers" }],
    },
    releases: [
      {
        id: "dr-aud-2",
        version: "2.4.0",
        date: daysFromToday(-6),
        text: "The call history export page and its background job.",
        minor: false,
        pageIds: ["doc-aud-export", "doc-aud-export-job"],
      },
      {
        id: "dr-aud-1",
        version: "2.3.1",
        date: daysFromToday(-9),
        text: "Wording of the reminders section.",
        minor: true,
        pageIds: ["doc-aud-callbacks"],
      },
    ],
    graph: { status: "disabled" },
  },
  {
    repositoryId: "repo-cbv",
    projectId: "prj-cbv",
    name: "bellavista-store",
    generation: {
      status: "never",
      lastAt: null,
      commit: null,
      costUsd: null,
      provider: null,
      reason: null,
    },
    brief: null,
    releases: [],
    graph: { status: "disabled" },
  },
];
