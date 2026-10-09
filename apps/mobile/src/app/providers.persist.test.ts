import type { Query } from "@tanstack/react-query";
import { shouldPersistQuery } from "./providers";

function query(queryKey: readonly unknown[], status: "success" | "error" | "pending" = "success"): Query {
  return { queryKey, state: { status }, isDisabled: () => false } as unknown as Query;
}

describe("shouldPersistQuery", () => {
  test("le sessioni degli agenti non si persistono (contengono email e output dei tool)", () => {
    expect(shouldPersistQuery(query(["agent-sessions", "detail", "x"]))).toBe(false);
    expect(shouldPersistQuery(query(["agent-sessions", "list", {}]))).toBe(false);
    expect(shouldPersistQuery(query(["agent-sessions", "events", "x"]))).toBe(false);
  });

  test("le altre query riuscite si persistono", () => {
    expect(shouldPersistQuery(query(["work", "ticket", "x"]))).toBe(true);
  });

  test("le altre query non riuscite no (default di TanStack)", () => {
    expect(shouldPersistQuery(query(["work", "ticket", "x"], "error"))).toBe(false);
  });
});
