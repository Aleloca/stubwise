import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Attachment } from "../lib/api";
import { AttachmentUpload } from "./attachment-upload";

/**
 * Test dell'upload allegati: validazione client (tipo/size) prima di toccare
 * l'API, chiamata multipart corretta sul file valido, stato disabilitato.
 */

const TICKET_ID = "11111111-1111-4111-8111-111111111111";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const createdAttachment: Attachment = {
  id: "att-new",
  ticketId: TICKET_ID,
  commentId: null,
  filename: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 1024,
  createdAt: "2026-06-01T10:00:00.000Z",
};

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fetchMock.mockReset();
});

function renderUpload(
  props: Partial<React.ComponentProps<typeof AttachmentUpload>> = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AttachmentUpload ticketId={TICKET_ID} {...props} />
    </QueryClientProvider>,
  );
  return queryClient;
}

/** Input file della UI (label i18n "Attach a file"). */
function fileInput(): HTMLInputElement {
  return screen.getByLabelText(/attach a file/i) as HTMLInputElement;
}

describe("AttachmentUpload", () => {
  it("file con tipo non ammesso: mostra errore e NON chiama l'API", async () => {
    renderUpload();
    const bad = new File(["x"], "virus.exe", { type: "application/x-msdownload" });

    // `applyAccept: false`: l'input ha un `accept` che il browser userebbe per
    // filtrare, ma la validazione lato JS resta una difesa (drag-drop, browser
    // permissivi) ed è ciò che testiamo qui.
    await userEvent.upload(fileInput(), bad, { applyAccept: false });

    expect(await screen.findByRole("alert")).toHaveTextContent(/file type/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("file oltre 10MB: mostra errore di dimensione e NON chiama l'API", async () => {
    renderUpload();
    // 11 MB di "contenuto": oltre il limite di 10MB.
    const big = new File([new Uint8Array(11 * 1024 * 1024)], "big.png", {
      type: "image/png",
    });

    await userEvent.upload(fileInput(), big);

    expect(await screen.findByRole("alert")).toHaveTextContent(/too large|10\s*MB/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("file valido: chiama uploadAttachment via multipart e invalida al successo", async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, createdAttachment));
    const queryClient = renderUpload();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    const good = new File(["hello"], "screenshot.png", { type: "image/png" });
    await userEvent.upload(fileInput(), good);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/api/tickets/${TICKET_ID}/attachments`);
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeInstanceOf(FormData);
    const form = init!.body as FormData;
    expect(form.get("file")).toBeInstanceOf(File);
    expect((form.get("file") as File).name).toBe("screenshot.png");

    await waitFor(() => expect(invalidate).toHaveBeenCalled());
  });

  it("con commentId valido: lega l'allegato al commento nel form", async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, createdAttachment));
    renderUpload({ commentId: "comment-42" });

    const good = new File(["hello"], "screenshot.png", { type: "image/png" });
    await userEvent.upload(fileInput(), good);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const form = fetchMock.mock.calls[0]![1]!.body as FormData;
    expect(form.get("commentId")).toBe("comment-42");
  });

  it("disabled (storage off): input disabilitato + hint", () => {
    renderUpload({ disabled: true });
    expect(fileInput()).toBeDisabled();
    expect(screen.getByText(/storage|configure/i)).toBeInTheDocument();
  });
});
