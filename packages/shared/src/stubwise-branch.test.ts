import { describe, expect, it } from "vitest";
import { STUBWISE_BRANCH_RE, stubwiseTicketNumber } from "./stubwise-branch.js";

describe("STUBWISE_BRANCH_RE", () => {
  it("riconosce il branch di un fix e ne estrae il numero del ticket", () => {
    expect(STUBWISE_BRANCH_RE.exec("stubwise/ticket-42")?.[1]).toBe("42");
    expect(stubwiseTicketNumber("stubwise/ticket-42")).toBe(42);
  });

  it("gli altri branch `stubwise/*` NON sono di un ticket", () => {
    // Il worker apre davvero PR su `stubwise/graphify-setup` (graph/setup-pr.ts):
    // non hanno un ticket, e il ciclo di correzione non le riguarda.
    expect(stubwiseTicketNumber("stubwise/graphify-setup")).toBeNull();
    expect(stubwiseTicketNumber("stubwise/ticket-")).toBeNull();
    expect(stubwiseTicketNumber("stubwise/ticket-4/x")).toBeNull();
    expect(stubwiseTicketNumber("feature/ticket-4")).toBeNull();
  });

  it.each([
    ["", null],
    ["refs/heads/stubwise/ticket-42", null],
    ["stubwise/ticket-42 ", null],
    ["stubwise/ticket-42\n", null],
    ["stubwise/ticket-99999999999999999999", null],
    // Limite noto: gli zeri iniziali sono accettati (Stubwise non crea mai quei branch).
    ["stubwise/ticket-007", 7],
  ])("stubwiseTicketNumber(%j) → %s", (branch, expected) => {
    expect(stubwiseTicketNumber(branch)).toBe(expected);
  });
});
