import type { TranscriptItem } from "@stubwise/shared";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Transcript } from "./transcript";

describe("Transcript", () => {
  it("la domanda in sola lettura (senza renderQuestion): un'immagine non si carica, resta l'alt", () => {
    const item = {
      kind: "question",
      id: "q1",
      at: "2026-10-09T10:00:00.000Z",
      question: {
        id: "q1",
        source: "agent",
        question: "Is ![the chart](https://x.test/q.png) right?",
        askedAt: "2026-10-09T10:00:00.000Z",
        answered: false,
      },
    } as unknown as TranscriptItem;
    const { container } = render(<Transcript items={[item]} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.innerHTML).not.toContain("x.test");
    expect(container.textContent).toContain("Is the chart right?");
  });

  it("il testo dell'agente fuori dalle domande mostra ancora le immagini", () => {
    const item = {
      kind: "text",
      id: "t1",
      text: "![grafico](https://x.test/p.png)",
      at: "2026-10-09T10:00:00.000Z",
      live: false,
    } as TranscriptItem;
    const { container } = render(<Transcript items={[item]} />);
    expect(container.querySelector("img")).toHaveAttribute("src", "https://x.test/p.png");
  });
});
