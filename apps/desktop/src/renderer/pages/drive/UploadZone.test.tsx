import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DriveUploadOptions } from "../../data/types";
import { useUploads } from "./UploadZone";

// I caricamenti nella build app (area 5, fetta 2): l'avanzamento è quello
// vero (dal main o dall'XHR), non simulato; «Cancel» e lo smontaggio della
// pagina (cambio persona compreso) annullano il caricamento.

const upload = vi.fn();
vi.mock("../../data/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../data/queries")>()),
  useUploadFiles: () => ({ mutateAsync: upload }),
}));

type Call = { projectId: string; files: { name: string; file?: File }[]; options?: DriveUploadOptions };

beforeEach(() => {
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
  upload.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

const file = () => new File(["abcd"], "spec.pdf", { type: "application/pdf" });

describe("i caricamenti nella build app", () => {
  it("manda il File e mostra l'avanzamento vero; finito, la riga se ne va", async () => {
    let finish: (v: unknown) => void = () => undefined;
    upload.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const onUploaded = vi.fn();
    const { result } = renderHook(() => useUploads(onUploaded));
    act(() => result.current.start([file()], "p1"));
    await waitFor(() => expect(upload).toHaveBeenCalled());
    const call = upload.mock.calls[0]![0] as Call;
    expect(call.projectId).toBe("p1");
    expect(call.files[0]!.file?.name).toBe("spec.pdf");
    act(() => call.options!.onProgress!(2));
    expect(result.current.store.get().items[0]).toMatchObject({ status: "uploading", loaded: 2 });
    const row = { id: "f1", code: "AUD-F1", name: "spec.pdf", type: "pdf", mime: "application/pdf" };
    await act(async () => finish([{ name: "spec.pdf", file: row, error: null }]));
    await waitFor(() => expect(result.current.store.get().items).toEqual([]));
    expect(onUploaded).toHaveBeenCalledWith(row);
  });

  it("«Cancel» annulla il caricamento in corso", async () => {
    upload.mockImplementation(() => new Promise(() => undefined));
    const { result } = renderHook(() => useUploads());
    act(() => result.current.start([file()], "p1"));
    await waitFor(() => expect(upload).toHaveBeenCalled());
    const { signal } = (upload.mock.calls[0]![0] as Call).options!;
    act(() => result.current.cancel(result.current.store.get().items[0]!.key));
    expect(signal!.aborted).toBe(true);
    expect(result.current.store.get().items).toEqual([]);
  });

  it("smontare la pagina (cambio persona compreso) annulla i caricamenti", async () => {
    upload.mockImplementation(() => new Promise(() => undefined));
    const { result, unmount } = renderHook(() => useUploads());
    act(() => result.current.start([file()], "p1"));
    await waitFor(() => expect(upload).toHaveBeenCalled());
    const { signal } = (upload.mock.calls[0]![0] as Call).options!;
    unmount();
    expect(signal!.aborted).toBe(true);
  });
});
