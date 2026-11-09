import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UrgencyMark } from "./marks";

// «urgent» del server si legge come il livello più alto del prototipo, ma col
// suo nome: il dato non si perde (fetta 4).
describe("UrgencyMark", () => {
  it("una richiesta urgente dice «Urgent», al livello più alto", () => {
    const { container } = render(<UrgencyMark urgency="high" urgent />);
    expect(screen.getByText("Urgent")).toBeInTheDocument();
    expect(container.querySelector("[data-urgency]")?.getAttribute("data-urgency")).toBe("urgent");
  });

  it("senza il segno, il livello del prototipo", () => {
    render(<UrgencyMark urgency="high" />);
    expect(screen.getByText("High")).toBeInTheDocument();
  });
});
