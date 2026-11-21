import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import type { ProductFirstVersionView } from "../types";
import { setSessionPersonId } from "../session";
import { ViewerProvider } from "../viewer";
import { useProductFirstVersion } from "./productDocs";

// R11-6: nella build app la prima versione non ha un evento. Mentre scrive
// si rilegge ogni 2 s, e a ogni pagina scritta si rilegge anche lo spazio
// (l'albero); finita, si ferma.

// Il cancello `product-claude-actions` è spento nella build app: qui acceso.
vi.mock("../integration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../integration")>()),
  featureIntegrated: () => true,
}));

const LAURA = "p-laura";
const PROJECT = "prj-acq";

const view = (over: Partial<ProductFirstVersionView>): ProductFirstVersionView => ({
  projectId: PROJECT,
  groupId: "g",
  byId: LAURA,
  byName: "Laura Costa",
  status: "writing",
  pagesDone: 0,
  pagesTotal: 2,
  interrupted: false,
  sources: [],
  pages: [],
  acceptedPageIds: [],
  bannerPageIds: [],
  undo: { enabled: true },
  permissions: { edit: true },
  ...over,
});

beforeEach(() => {
  api.resetApi();
  api.setLatency(0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("useProductFirstVersion nella build app", () => {
  it("mentre scrive si rilegge ogni 2 s; una pagina in più rilegge lo spazio; finita si ferma", async () => {
    vi.stubEnv("VITE_STUBWISE_BUILD", "app");
    setSessionPersonId(LAURA);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const spy = vi
      .spyOn(api.productDocs, "getProductFirstVersion")
      .mockResolvedValueOnce(view({ pagesDone: 0 }))
      .mockResolvedValueOnce(view({ pagesDone: 1 }))
      .mockResolvedValue(view({ status: "done", pagesDone: 2 }));
    const client = new QueryClient();
    client.setQueryData(["as", LAURA, "productDocs", "space", PROJECT], { stale: true });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <ViewerProvider initialPersonId={LAURA}>{children}</ViewerProvider>
      </QueryClientProvider>
    );
    renderHook(() => useProductFirstVersion(PROJECT), { wrapper });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        client.getQueryState(["as", LAURA, "productDocs", "space", PROJECT])?.isInvalidated,
      ).toBe(true),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(3));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(spy).toHaveBeenCalledTimes(3);
  });
});
