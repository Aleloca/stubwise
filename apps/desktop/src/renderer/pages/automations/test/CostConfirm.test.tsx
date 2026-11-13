import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CostConfirm } from "./CostConfirm";

// Area 7, F3 (D4, F3-3 = a): la prova arriva al primo passo di Claude e si
// ferma; chi prova conferma il costo stimato UNA volta, poi la prova va.

describe("la conferma del costo della prova", () => {
  it("dice quante volte chiede a Claude e quanto costa, e conferma una volta", async () => {
    const onConfirm = vi.fn();
    render(
      <CostConfirm
        cost={{ claudeSteps: 2, estimateUsd: 0.04, model: "sonnet" }}
        busy={false}
        onConfirm={onConfirm}
      />,
    );
    const region = screen.getByRole("region", { name: "Claude in this test" });
    expect(region).toHaveTextContent("asks Claude 2 times");
    expect(region).toHaveTextContent("$0.04");
    expect(region).toHaveTextContent("monthly AI budget");
    await userEvent.click(screen.getByRole("button", { name: "Test with Claude" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("mentre conferma il bottone non si preme di nuovo", () => {
    render(
      <CostConfirm
        cost={{ claudeSteps: 1, estimateUsd: 0.01, model: "sonnet" }}
        busy
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByRole("region", { name: "Claude in this test" })).toHaveTextContent(
      "asks Claude once",
    );
    expect(screen.getByRole("button", { name: "Test with Claude" })).toBeDisabled();
  });

  it("un modello senza tariffa: il costo non si stima, ma si conferma lo stesso", () => {
    render(
      <CostConfirm
        cost={{ claudeSteps: 2, estimateUsd: null, model: "x" }}
        busy={false}
        onConfirm={() => {}}
      />,
    );
    const region = screen.getByRole("region", { name: "Claude in this test" });
    expect(region).toHaveTextContent("asks Claude 2 times");
    expect(region).toHaveTextContent("the cost can't be estimated");
    expect(region).not.toHaveTextContent("$");
  });

  it("una stima che è solo un tetto (elenchi o input che l'esempio non ha) dice «up to»", () => {
    render(
      <CostConfirm
        cost={{ claudeSteps: 50, estimateUsd: 0.5, model: "sonnet", upperBound: true }}
        busy={false}
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByRole("region", { name: "Claude in this test" })).toHaveTextContent(
      "up to 50 times: at most $0.50",
    );
  });
});
