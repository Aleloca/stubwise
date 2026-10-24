import type { Conversation, ConversationEvent, ScriptStep } from "../types";
import { AUTOMATIC_CONVERSATIONS } from "./conversations/automatic";
import { FREE_CONVERSATIONS } from "./conversations/free";
import type { Seeded } from "./conversations/helpers";
import { WORK_CONVERSATIONS } from "./conversations/work";

// Le conversazioni con Claude del seed: libere, sessioni di lavoro (task e
// refine) e sessioni automatiche, ognuna col suo flusso di eventi già
// accaduti. I file in `conversations/` le scrivono per famiglia.

const ALL: Seeded[] = [...FREE_CONVERSATIONS, ...WORK_CONVERSATIONS, ...AUTOMATIC_CONVERSATIONS];

export const CONVERSATIONS: Conversation[] = ALL.map((s) => s.conversation);

/** Il flusso di ogni conversazione, per id, in ordine di tempo. */
export const CONVERSATION_EVENTS: Record<string, ConversationEvent[]> = Object.fromEntries(
  ALL.map((s) => [s.conversation.id, s.events]),
);

/**
 * Quello che fanno da qui in avanti le sessioni ancora al lavoro: il motore
 * dello stream lo esegue la prima volta che qualcuno le apre. Deterministico:
 * stessi passi, stessi pezzi, stessi id a ogni avvio.
 */
export const SCRIPTS: Record<string, ScriptStep[]> = {
  // Esportazione delle chiamate: finisce il percorso in background.
  "cv-run-aud-5": [
    { step: "finish_action" },
    { step: "action", tool: "repo.edit", label: "Edits src/calls/export-job.ts" },
    {
      step: "action",
      tool: "shell",
      label: "Runs the call history tests",
      input: "pnpm vitest run src/calls",
      result: "29 passed",
    },
    {
      step: "say",
      text: [
        "The background path is in place: periods longer than a month are prepared by a job and the link arrives by email, valid for seven days.",
        "",
        "- the download button stays disabled while an export is being prepared;",
        "- the email uses the existing *Export ready* template;",
        "- five new tests cover the columns, the job and the button state.",
        "",
        "Now the full suite before opening the pull request.",
      ].join("\n"),
    },
    {
      step: "action",
      tool: "shell",
      label: "Runs the full test suite",
      input: "pnpm test",
      result: "412 passed",
    },
    {
      step: "event",
      event: { type: "work_result", kind: "pr_opened", text: "Pull request #415 opened" },
    },
    { step: "event", event: { type: "phase", phase: "execution", outcome: "ok" } },
    { step: "state", state: "finished", outcome: "ok" },
  ],
  // Correzione dopo la review della PR #411: arriva il messaggio di Laura.
  "cv-run-stw-3": [
    { step: "finish_action", result: "31 passed" },
    { step: "deliver" },
    {
      step: "say",
      text: "Got it, Laura: the announcement text moves to the locale files, in English and Italian, and the component only reads the key.",
    },
    { step: "action", tool: "repo.edit", label: "Edits apps/desktop/src/renderer/i18n/en.json" },
    { step: "action", tool: "repo.edit", label: "Edits apps/desktop/src/renderer/i18n/it.json" },
    {
      step: "action",
      tool: "repo.edit",
      label: "Edits apps/desktop/src/renderer/pages/board/announce.ts",
    },
    {
      step: "action",
      tool: "shell",
      label: "Runs the board tests",
      input: "pnpm --filter @stubwise/desktop exec vitest run src/renderer/pages/board",
      result: "33 passed",
    },
    {
      step: "say",
      text: "The drop is now announced once, from the live region, with the text from the locale files. Pushing the correction to pull request #411.",
    },
    {
      step: "event",
      event: { type: "work_result", kind: "correction", text: "Correction pushed to #411" },
    },
    { step: "event", event: { type: "phase", phase: "correction", outcome: "ok" } },
    { step: "state", state: "finished", outcome: "ok" },
  ],
  // Le misure dei banner di MKX: Claude raccoglie le misure e chiede a
  // Giulia per quale uscita prepararle.
  "cv-run-mkx-11": [
    { step: "finish_action", result: "Print: half page 210 × 140 mm · web: 300 × 600" },
    {
      step: "action",
      tool: "web.read",
      label: "Reads the advertising kit of Il Mobile",
      result: "Print: full page 240 × 320 mm · no web banners",
    },
    {
      step: "say",
      text: [
        "I have the sizes of all three magazines:",
        "",
        "| Magazine | Print | Web |",
        "| --- | --- | --- |",
        "| Cucine Oggi | full page 230 × 297 mm | 300 × 250, 728 × 90 |",
        "| Arredo & Design | half page 210 × 140 mm | 300 × 600 |",
        "| Il Mobile | full page 240 × 320 mm | — |",
        "",
        "The media plan books print and web for April, but the budget line only mentions print.",
      ].join("\n"),
    },
    {
      step: "event",
      event: {
        type: "question",
        questionId: "q-mkx-11-1",
        text: "Which sizes should go in the task for the designers?",
        options: [
          {
            label: "Print and web",
            consequence: "Five formats to prepare; the web ones only run if the budget allows.",
            recommended: true,
          },
          {
            label: "Print only",
            consequence: "Three formats; the web banners are left out of April.",
          },
        ],
        answer: null,
      },
    },
    { step: "state", state: "awaiting_answer" },
  ],
  // Refine delle ore di silenzio: Claude finisce di scrivere il piano.
  "cv-refine-stw-4": [
    { step: "finish_action" },
    {
      step: "event",
      event: {
        type: "work_result",
        kind: "plan_updated",
        text: "Plan written: setting, quiet-hours check in the push sender, summary push, tests",
      },
    },
    {
      step: "say",
      text: [
        "The plan is written, in four steps:",
        "",
        "1. a *Quiet hours* setting per person, 20:00–08:00 by default, in the person's timezone;",
        "2. the push sender checks the quiet hours and holds the push, never the inbox;",
        "3. at the end of the quiet hours one summary push with the count of what arrived;",
        "4. direct mentions skip the check, as Elena asked.",
        "",
        "Read it in the request and tell me if something is missing before it becomes a task.",
      ].join("\n"),
    },
  ],
};
