import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changelog, resetApi, setLatency } from "../../data/api";
import type { ChangeEntryView } from "../../data/changelog/types";
import { setSessionPersonId } from "../../data/session";
import { ViewerProvider } from "../../data/viewer";
import { clearToasts, ToastRegion } from "../../tasks-ui/Toast";
import { ChangeJournal } from "./ChangeLogPage";

// Revisione del lotto 2 (minor): «Undid:» legge le pagine dopo per trovare la
// voce annullata (r.1250); se la pagina dopo non si legge (un errore che
// resta), si ferma e lo dice, invece di rilanciare «Load more» all'infinito.

beforeEach(() => {
  setLatency(0);
  resetApi();
});
afterEach(() => clearToasts());

describe("«Undid:» con la pagina dopo che non si legge", () => {
  it("un errore: si ferma, lo dice, e non rilancia", async () => {
    setSessionPersonId("p-roberta");
    const all = await changelog.listChanges();
    const undo = all.find((e) => e.undoneEntry)!;
    expect(undo).toBeDefined();
    // La voce annullata non è fra quelle mostrate: sta «in una pagina dopo».
    const entries: ChangeEntryView[] = all.filter((e) => e.id !== undo.undoneEntry!.id);
    const onMore = vi.fn();
    let fail: (v: boolean) => void = () => {};
    function Harness() {
      const [failed, setFailed] = useState(false);
      fail = setFailed;
      return (
        <>
          <ChangeJournal
            state="ready"
            entries={entries}
            onRetry={() => {}}
            filtered={false}
            onClear={() => {}}
            empty=""
            showProject
            more={{ onMore, loading: false, failed }}
          />
          <ToastRegion />
        </>
      );
    }
    const router = createRouter({
      routeTree: createRootRoute({ component: Harness }),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ViewerProvider initialPersonId="p-roberta">
          <RouterProvider router={router} />
        </ViewerProvider>
      </QueryClientProvider>,
    );
    const row = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(`[data-change-id="${undo.id}"]`);
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.click(row.querySelector<HTMLElement>("[data-undid] button")!);
    await waitFor(() => expect(onMore).toHaveBeenCalledTimes(1));
    // La pagina dopo non si è letta, e resta così.
    act(() => fail(true));
    expect(
      await screen.findByText("Older changes couldn't be loaded. Try again later."),
    ).toBeInTheDocument();
    expect(onMore).toHaveBeenCalledTimes(1);
  });
});
