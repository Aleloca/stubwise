import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationsSection } from "./notifications-section";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("NotificationsSection", () => {
  it("accanto al budget mensile spiega cosa conta", async () => {
    fetchMock.mockImplementation((input) => {
      const body = String(input).includes("instance")
        ? { contentLanguage: "it", monthlyBudgetUsd: 50 }
        : { enabled: false, webhookUrl: null, format: "slack" };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Suspense fallback={null}>
          <NotificationsSection />
        </Suspense>
      </QueryClientProvider>,
    );
    expect(
      await screen.findByText(/Counts every AI usage that has a cost: fix, review/),
    ).toBeInTheDocument();
  });
});
