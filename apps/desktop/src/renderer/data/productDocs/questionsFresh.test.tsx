import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetApi, setLatency } from "../api";
import { withoutSeed11b } from "../seed/productDocs/without11b";
import { useClaudeDecisions } from "../queries";
import { ViewerProvider } from "../viewer";
import { askProductQuestion, whenProductClaudeIdle } from "./claude";
import { answerProductQuestionAs } from "./questions";

// «Decide» della Home si tiene fresco da solo sulle domande di Claude della
// doc di prodotto (11b, Task 4): una domanda che il motore fa mentre la Home
// è aperta compare, e una risposta data altrove (un'altra persona) la toglie.

const PAGE = "pp-acq-sign-in";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <ViewerProvider initialPersonId="p-laura">{children}</ViewerProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  resetApi();
  setLatency(0);
  // Senza le domande del seme 11b: «Decide» parte vuoto.
  withoutSeed11b();
});
afterEach(async () => {
  await whenProductClaudeIdle();
  resetApi();
});

const productIds = (data: { kind: string; id: string }[] | undefined) =>
  (data ?? []).filter((d) => d.kind === "productQuestion").map((d) => d.id);

it("una domanda nuova entra in «Decide» e una risposta di Marco la toglie, senza ricaricare a mano", async () => {
  const { result } = renderHook(() => useClaudeDecisions(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(productIds(result.current.data)).toEqual([]);

  let id = "";
  act(() => {
    id = askProductQuestion(
      PAGE,
      "blk-acq-signin-2",
      {
        id: "fact-fresh",
        pageId: PAGE,
        anchorId: "blk-acq-signin-2",
        change: { kind: "replace", text: { text: "Maybe Apple too.", marks: [] } },
        clarity: "vague",
      },
      { kind: "decision", id: "dl-none" },
      "vague",
    );
  });
  await waitFor(() => expect(productIds(result.current.data)).toEqual([`product:${id}`]));

  act(() => answerProductQuestionAs("p-marco", id, "keep"));
  await waitFor(() => expect(productIds(result.current.data)).toEqual([]));
});
