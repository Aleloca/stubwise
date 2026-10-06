import { describe, expect, it } from "vitest";
import { isCorrectablePr, STUBWISE_BRANCH_RE, stubwiseTicketNumber } from "./stubwise-branch.js";

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

describe("isCorrectablePr — la regola unica di correggibilità", () => {
  const base = { ticketNumber: 42, adoptedAt: null, adoptionReleasedAt: null } as const;

  it("il branch di Stubwise DEL ticket è correggibile", () => {
    expect(isCorrectablePr({ ...base, branch: "stubwise/ticket-42" })).toBe(true);
  });

  it("il branch di Stubwise di un ALTRO ticket no", () => {
    expect(isCorrectablePr({ ...base, branch: "stubwise/ticket-7" })).toBe(false);
  });

  it("un branch qualunque mai adottato no", () => {
    expect(isCorrectablePr({ ...base, branch: "feature/login" })).toBe(false);
  });

  it("un branch adottato e non rilasciato sì", () => {
    expect(isCorrectablePr({ ...base, branch: "feature/login", adoptedAt: new Date() })).toBe(true);
  });

  it("un branch adottato e poi rilasciato no", () => {
    expect(
      isCorrectablePr({
        ...base,
        branch: "feature/login",
        adoptedAt: new Date("2026-10-01"),
        adoptionReleasedAt: new Date("2026-10-02"),
      }),
    ).toBe(false);
  });

  it("accetta anche le date come stringhe ISO (righe lette da JSON)", () => {
    expect(isCorrectablePr({ ...base, branch: "feature/x", adoptedAt: "2026-10-01T00:00:00.000Z" })).toBe(true);
  });
});
