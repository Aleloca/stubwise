import { render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../data/api";
import type { ProjectStatus } from "../data/types";
import type { Stall } from "../domain/stalled";
import i18n, { setLanguage } from "../i18n";
import { renderWithData } from "../test/renderWithData";
import { LoadBar } from "./LoadBar";
import { PersonChip } from "./PersonChip";
import { SizeMark } from "./SizeMark";
import { StallMark, stallText } from "./StallMark";
import { StatusLabel } from "./StatusLabel";

beforeEach(() => {
  setLatency(0);
  resetApi();
});

afterEach(() => {
  act(() => setLanguage("en"));
});

const status = (family: ProjectStatus["family"], name: string): ProjectStatus => ({
  id: `s-${family}`,
  projectId: "p1",
  name,
  family,
  order: 0,
});

describe("SizeMark", () => {
  it("mostra la lettera della taglia", () => {
    render(<SizeMark size="M" />);
    expect(screen.getByText("M")).toBeInTheDocument();
  });

  it("senza stima mostra «—» con l'etichetta accessibile «No estimate»", () => {
    render(<SizeMark size={null} />);
    const mark = screen.getByRole("img", { name: "No estimate" });
    expect(mark).toHaveTextContent("—");
  });
});

describe("LoadBar", () => {
  it("con task senza stima mostra «+3» accanto, e nessun numero di peso", () => {
    const { container } = render(<LoadBar weight={5} max={10} unsized={3} />);
    expect(screen.getByText("+3 no estimate")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\b5\b|\b10\b/);
    const fill = container.querySelector<HTMLElement>("[data-load-segment]")!;
    expect(fill.style.width).toBe("50%");
  });

  it("senza task senza stima non mostra il «+N»", () => {
    render(<LoadBar weight={2} max={8} unsized={0} />);
    expect(screen.queryByText(/no estimate/)).toBeNull();
  });

  it("i due segmenti (questo progetto, altri progetti) stanno nella stessa barra", () => {
    const { container } = render(
      <LoadBar
        max={10}
        unsized={0}
        segments={[
          { weight: 3, tone: "strong", label: "This project" },
          { weight: 2, tone: "faint", label: "Other projects" },
        ]}
      />,
    );
    const segs = [...container.querySelectorAll<HTMLElement>("[data-load-segment]")];
    expect(segs.map((s) => [s.dataset.loadSegment, s.style.width])).toEqual([
      ["strong", "30%"],
      ["faint", "20%"],
    ]);
  });

  it("non esce dalla barra se il peso supera il massimo, e con massimo 0 è vuota", () => {
    const { container, rerender } = render(<LoadBar weight={12} max={10} unsized={0} />);
    expect(container.querySelector<HTMLElement>("[data-load-segment]")!.style.width).toBe("100%");
    rerender(<LoadBar weight={0} max={0} unsized={0} />);
    expect(container.querySelector<HTMLElement>("[data-load-segment]")!.style.width).toBe("0%");
  });
});

describe("StatusLabel", () => {
  it("scrive il nome dello stato e porta il segno della famiglia", () => {
    const { container } = render(<StatusLabel status={status("active", "In review")} />);
    expect(screen.getByText("In review")).toBeInTheDocument();
    expect(container.querySelector('[data-status-family="active"] svg')).not.toBeNull();
  });

  it("ogni famiglia ha una forma diversa", () => {
    const shapes = (["todo", "active", "closed"] as const).map((f) => {
      const { container, unmount } = render(<StatusLabel status={status(f, f)} />);
      const svg = container.querySelector("svg")!.innerHTML;
      unmount();
      return svg;
    });
    expect(new Set(shapes).size).toBe(3);
  });
});

describe("PersonChip", () => {
  it("iniziali e nome; Claude con l'anello tratteggiato", async () => {
    renderWithData(
      <>
        <PersonChip personId="p-elena" />
        <PersonChip personId="p-claude" />
      </>,
    );
    expect(await screen.findByText("Elena Moretti")).toBeInTheDocument();
    expect(screen.getByText("EM")).toBeInTheDocument();
    const claude = document.querySelector('[data-person="p-claude"]')!;
    expect(claude.querySelector("[data-claude-ring]")).not.toBeNull();
    expect(document.querySelector('[data-person="p-elena"] [data-claude-ring]')).toBeNull();
  });

  it("senza assegnatario dice «Unassigned»", () => {
    renderWithData(<PersonChip personId={null} />);
    expect(screen.getByText("Unassigned")).toBeInTheDocument();
  });
});

describe("stallText / StallMark", () => {
  const t = i18n.t.bind(i18n);
  const names = { personName: () => "Elena Moretti", taskCode: () => "MKX-4" };
  const at = (reason: Stall["reason"], days = 4): Stall => ({ reason, since: "2026-10-19", days });

  it("frase del motivo con i giorni", () => {
    expect(stallText(at({ kind: "decision", personId: "p-elena" }), t, names)).toBe(
      "Waiting for Elena's decision · 4 days",
    );
    expect(stallText(at({ kind: "blocked_by", taskId: "t" }, 1), t, names)).toBe(
      "Blocked by MKX-4 · 1 day",
    );
    expect(stallText(at({ kind: "idle" }, 9), t, names)).toBe("Nobody has touched it for 9 days");
    expect(
      stallText(at({ kind: "manual", reason: "Waiting on the client", note: "" }), t, names),
    ).toBe("Waiting on the client · 4 days");
    expect(stallText(at({ kind: "claude_question" }, 0), t, names)).toBe(
      "Claude asked a question · since today",
    );
  });

  it("in italiano", () => {
    act(() => setLanguage("it"));
    expect(stallText(at({ kind: "decision", personId: "p-elena" }), t, names)).toBe(
      "Aspetta la decisione di Elena · 4 giorni",
    );
  });

  it("StallMark risolve il nome della persona dai dati", async () => {
    renderWithData(<StallMark stall={at({ kind: "decision", personId: "p-elena" })} />);
    const mark = document.querySelector<HTMLElement>("[data-stall-mark]")!;
    expect(mark).toHaveAttribute("data-stall-reason", "decision");
    await screen.findByText("Waiting for Elena's decision · 4 days");
  });
});
