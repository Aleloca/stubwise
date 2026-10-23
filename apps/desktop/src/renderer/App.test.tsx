import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  it("monta l'app e mostra il nome del prodotto", () => {
    render(<App />);
    expect(screen.getByText("Stubwise")).toBeInTheDocument();
  });
});
