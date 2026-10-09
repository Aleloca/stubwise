import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ToolCard } from "./tool-card";

describe("ToolCard", () => {
  it("non mette in maiuscolo il comando: `ls -la` e `LS -LA` sono comandi diversi", () => {
    render(
      <ToolCard
        live={false}
        item={
          {
            kind: "tool",
            id: "t1",
            name: "Bash",
            input: { command: "ls -la ./src" },
            result: null,
          } as never
        }
      />,
    );
    const title = screen.getByText(/ls -la \.\/src/);
    expect(title.closest("span")).not.toHaveClass("uppercase");
  });
});
