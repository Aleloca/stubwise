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
    ...overrides,
  };
}

describe("AIJobTimeline", () => {
  it("senza job mostra lo stato vuoto", () => {
    render(<AIJobTimeline jobs={[]} />);

    expect(screen.getByText(/nessuna attività ai/i)).toBeInTheDocument();
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

    expect(screen.getByText("In coda")).toBeInTheDocument();
    expect(screen.getByText("Fix in corso")).toBeInTheDocument();
    expect(screen.getByText("PR aperta")).toBeInTheDocument();
    expect(screen.getByText("Fallito")).toBeInTheDocument();
    expect(screen.getByText("Saltato")).toBeInTheDocument();
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

    expect(screen.getByRole("link", { name: /vedi pr/i })).toHaveAttribute(
      "href",
      "https://github.com/acme/repo/pull/7",
    );
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
    const toggle = screen.getByRole("button", { name: /mostra log/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/triage ok/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /nascondi log/i }));
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/triage ok/)).not.toBeInTheDocument();
  });

  it("job senza log non offre il bottone del log", () => {
    render(<AIJobTimeline jobs={[makeJob({ id: "j1", log: "" })]} />);

    expect(screen.queryByRole("button", { name: /log/i })).not.toBeInTheDocument();
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
    expect(within(entry).getByText(/inizio/i)).toBeInTheDocument();
    expect(within(entry).getByText(/fine/i)).toBeInTheDocument();
  });
});
