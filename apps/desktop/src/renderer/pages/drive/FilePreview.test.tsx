import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closePreview, isPreviewOpen, useDriveOpeners } from "./FilePreview";

// Le aperture nella build app (area 5, fetta 2): il file vero, dal server.
// L'anteprima del prototipo (il blob in memoria) non c'è: sul desktop è un
// salvataggio dal main, sul web la rotta `preview` in una scheda nuova. Lo fa
// `recordOpen`, che il server conta; un fallimento lo dice un avviso.

const record = vi.fn();
const toast = { show: vi.fn(), error: vi.fn() };
vi.mock("../../data/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../data/queries")>()),
  useRecordDriveOpen: () => ({ mutate: record }),
}));
vi.mock("../../tasks-ui/Toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../tasks-ui/Toast")>()),
  useToast: () => toast,
}));

const file = { id: "f1", code: "AUD-F1", name: "spec.pdf" };

beforeEach(() => {
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
  record.mockReset();
  toast.show.mockReset();
  toast.error.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  closePreview();
});

describe("le aperture nella build app", () => {
  it("l'anteprima apre il file dal server, senza la sovrapposizione del prototipo", () => {
    const { result } = renderHook(() => useDriveOpeners());
    act(() => result.current.preview(file, [file]));
    expect(record).toHaveBeenCalledWith({ fileId: "f1", via: "preview" }, expect.anything());
    expect(isPreviewOpen()).toBe(false);
  });

  it("il download passa dal server, senza l'avviso finto «scaricato»", () => {
    const { result } = renderHook(() => useDriveOpeners());
    act(() => result.current.download(file));
    expect(record).toHaveBeenCalledWith({ fileId: "f1", via: "download" }, expect.anything());
    expect(toast.show).not.toHaveBeenCalled();
  });

  it("un file sparito o un errore lo dice un avviso", () => {
    const { result } = renderHook(() => useDriveOpeners());
    act(() => result.current.download(file));
    const { onError } = record.mock.calls[0]![1] as { onError: (e: Error) => void };
    act(() => onError(new Error("not_found")));
    expect(toast.error).toHaveBeenLastCalledWith("spec.pdf is no longer available.");
    act(() => onError(new Error("failed")));
    expect(toast.error).toHaveBeenLastCalledWith("Couldn't download spec.pdf.");
  });

  it("nel prototipo l'anteprima resta quella sovrapposta", () => {
    vi.stubEnv("VITE_STUBWISE_BUILD", "prototype");
    const { result } = renderHook(() => useDriveOpeners());
    act(() => result.current.preview(file, [file]));
    expect(isPreviewOpen()).toBe(true);
  });
});
