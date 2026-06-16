import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AttachmentWithUrl } from "../lib/api";
import { AttachmentList } from "./attachment-list";

/**
 * Test della lista allegati: anteprima immagini vs etichetta+dimensione per i
 * file generici, link di download corretto e rimozione (mutation) con conferma.
 */

const TICKET_ID = "11111111-1111-4111-8111-111111111111";

const imageAttachment: AttachmentWithUrl = {
  id: "att-img",
  ticketId: TICKET_ID,
  commentId: null,
  filename: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 2048,
  createdAt: "2026-06-01T10:00:00.000Z",
  downloadUrl: "/api/attachments/att-img/download",
};

const pdfAttachment: AttachmentWithUrl = {
  id: "att-pdf",
  ticketId: TICKET_ID,
  commentId: null,
  filename: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 1_572_864, // 1.5 MB
  createdAt: "2026-06-01T10:05:00.000Z",
  downloadUrl: "/api/attachments/att-pdf/download",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fetchMock.mockReset();
});

function renderList(
  props: Partial<React.ComponentProps<typeof AttachmentList>> = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AttachmentList
        ticketId={TICKET_ID}
        attachments={[imageAttachment, pdfAttachment]}
        {...props}
      />
    </QueryClientProvider>,
  );
  return queryClient;
}

describe("AttachmentList", () => {
  it("rende un'anteprima <img> per gli allegati immagine", () => {
    renderList();
    const img = screen.getByRole("img", { name: "screenshot.png" });
    expect(img).toHaveAttribute("src", "/api/attachments/att-img/download");
  });

  it("rende nome + dimensione leggibile per i file non immagine", () => {
    renderList();
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    // 1.5 MB → dimensione formattata leggibile
    expect(screen.getByText(/1\.5\s*MB/)).toBeInTheDocument();
  });

  it("il link di download usa il downloadUrl dell'allegato", () => {
    renderList();
    const link = screen.getByRole("link", { name: /report\.pdf/i });
    expect(link).toHaveAttribute("href", "/api/attachments/att-pdf/download");
  });

  it("mostra il bottone remove e, dopo conferma, chiama DELETE e invalida", async () => {
    fetchMock.mockResolvedValue(jsonResponse(204, null));
    const queryClient = renderList({ canDelete: () => true });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    const removeButton = screen.getByRole("button", { name: /remove .*report\.pdf/i });
    // Primo click: arma la conferma, nessuna DELETE.
    await userEvent.click(removeButton);
    expect(fetchMock).not.toHaveBeenCalled();

    // Secondo click: scatena la DELETE.
    await userEvent.click(removeButton);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/attachments/att-pdf/download".replace("/download", ""),
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
  });

  it("nasconde il bottone remove quando canDelete è falso", () => {
    renderList({ canDelete: () => false });
    expect(screen.queryByRole("button", { name: /remove/i })).not.toBeInTheDocument();
  });

  it("senza allegati mostra lo stato vuoto", () => {
    renderList({ attachments: [] });
    expect(screen.getByText("// no attachments")).toBeInTheDocument();
  });
});
