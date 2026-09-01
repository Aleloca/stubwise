import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { AIJob } from "../lib/api";
import { AIJobTimeline } from "./ai-job-timeline";

function makeJob(overrides: Partial<AIJob>): AIJob {
  return {
    id: "j1",
    ticketId: "t1",
    status: "queued",
    log: "",
    prUrl: null,
    error: null,
    createdAt: "2026-06-01T10:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    providerLabel: null,
    providerKind: null,
    requestedByUserId: null,
    ...overrides,
  };
}

describe("AIJobTimeline", () => {
  it("senza job mostra lo stato vuoto", () => {
    render(<AIJobTimeline jobs={[]} />);

    expect(screen.getByText(/no ai activity/i)).toBeInTheDocument();
  });

  it("renderizza un job per stato con l'etichetta giusta", () => {
    render(
      <AIJobTimeline
        jobs={[
          makeJob({ id: "j1", status: "queued" }),
          makeJob({ id: "j2", status: "fixing" }),
          makeJob({ id: "j3", status: "pr_opened" }),
          makeJob({ id: "j4", status: "failed" }),
          makeJob({ id: "j5", status: "skipped" }),
        ]}
      />,
    );

    expect(screen.getByText("Queued")).toBeInTheDocument();
    expect(screen.getByText("Fixing")).toBeInTheDocument();
    expect(screen.getByText("PR opened")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Skipped")).toBeInTheDocument();
  });

  it("job con PR mergiata: etichetta PR merged e link alla PR visibile", () => {
    render(
      <AIJobTimeline
        jobs={[
          makeJob({
            id: "j1",
            status: "pr_merged",
            prUrl: "https://github.com/acme/repo/pull/7",
          }),
        ]}
      />,
    );

    expect(screen.getByText("PR merged")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /view pr/i })).toHaveAttribute(
      "href",
      "https://github.com/acme/repo/pull/7",
    );
  });

  it("job con PR: link alla pull request", () => {
    render(
      <AIJobTimeline
        jobs={[
          makeJob({
            id: "j1",
            status: "pr_opened",
            prUrl: "https://github.com/acme/repo/pull/7",
          }),
        ]}
      />,
    );

    expect(screen.getByRole("link", { name: /view pr/i })).toHaveAttribute(
      "href",
      "https://github.com/acme/repo/pull/7",
    );
  });

  it("job 'held': etichetta On hold e nota esplicativa", () => {
    render(<AIJobTimeline jobs={[makeJob({ id: "j1", status: "held" })]} />);

    expect(screen.getByText("On hold")).toBeInTheDocument();
    expect(screen.getByText(/Automation not started/i)).toBeInTheDocument();
  });

  it("job 'pr_closed': etichetta PR closed", () => {
    render(<AIJobTimeline jobs={[makeJob({ id: "j1", status: "pr_closed" })]} />);

    expect(screen.getByText("PR closed")).toBeInTheDocument();
  });

  it("job 'awaiting_plan_approval': etichetta Plan to approve e nota esplicativa", () => {
    render(<AIJobTimeline jobs={[makeJob({ id: "j1", status: "awaiting_plan_approval" })]} />);

    expect(screen.getByText("Plan to approve")).toBeInTheDocument();
    expect(screen.getByText(/approve or reject it/i)).toBeInTheDocument();
  });

  it("job 'awaiting_input': etichetta Question pending e nota esplicativa", () => {
    // Il job è fermo perché l'agente ha chiesto qualcosa: la nota è ciò che
    // spiega a chi guarda PERCHÉ non si muove nulla.
    render(<AIJobTimeline jobs={[makeJob({ id: "j1", status: "awaiting_input" })]} />);

    expect(screen.getByText("Question pending")).toBeInTheDocument();
    expect(screen.getByText(/asked a question/i)).toBeInTheDocument();
  });

  it("job fallito: mostra il messaggio d'errore", () => {
    render(
      <AIJobTimeline
        jobs={[makeJob({ id: "j1", status: "failed", error: "git clone: timeout" })]}
      />,
    );

    expect(screen.getByText("git clone: timeout")).toBeInTheDocument();
  });

  it("il log è collassato di default e si apre al click", async () => {
    render(
      <AIJobTimeline
        jobs={[makeJob({ id: "j1", status: "pr_opened", log: "triage ok\nfix applicato" })]}
      />,
    );

    expect(screen.queryByText(/triage ok/)).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: /show log/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/triage ok/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /hide log/i }));
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/triage ok/)).not.toBeInTheDocument();
  });

  it("job senza log non offre il bottone del log", () => {
    render(<AIJobTimeline jobs={[makeJob({ id: "j1", log: "" })]} />);

    expect(screen.queryByRole("button", { name: /log/i })).not.toBeInTheDocument();
  });

  it("job con provider collegato: mostra label e tipo del provider", () => {
    render(
      <AIJobTimeline
        jobs={[
          makeJob({
            id: "j1",
            status: "pr_opened",
            providerLabel: "Anthropic Account",
            providerKind: "account",
          }),
        ]}
      />,
    );

    const entry = screen.getByRole("listitem");
    expect(within(entry).getByText(/Anthropic Account/)).toBeInTheDocument();
    expect(within(entry).getByText(/account/i)).toBeInTheDocument();
  });

  it("job senza provider: non mostra la riga del provider", () => {
    render(
      <AIJobTimeline
        jobs={[makeJob({ id: "j1", status: "pr_opened", providerLabel: null, providerKind: null })]}
      />,
    );

    const entry = screen.getByRole("listitem");
    expect(within(entry).queryByText(/provider/i)).not.toBeInTheDocument();
  });

  it("mostra inizio e fine quando presenti", () => {
    render(
      <AIJobTimeline
        jobs={[
          makeJob({
            id: "j1",
            status: "pr_opened",
            startedAt: "2026-06-02T10:00:05.000Z",
            finishedAt: "2026-06-02T10:03:00.000Z",
          }),
        ]}
      />,
    );

    const entry = screen.getByRole("listitem");
    expect(within(entry).getByText(/started/i)).toBeInTheDocument();
    expect(within(entry).getByText(/finished/i)).toBeInTheDocument();
  });
});
