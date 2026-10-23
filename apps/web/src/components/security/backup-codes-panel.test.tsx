import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackupCodesPanel } from "./backup-codes-panel";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BackupCodesPanel", () => {
  it("«Continue» resta spento finché non si spunta «I saved the codes»", async () => {
    const onConfirm = vi.fn();
    render(<BackupCodesPanel codes={["aaaaa-bbbbb", "ccccc-ddddd"]} onConfirm={onConfirm} />);

    expect(screen.getByText("aaaaa-bbbbb")).toBeInTheDocument();
    expect(screen.getByText("ccccc-ddddd")).toBeInTheDocument();
    const next = screen.getByRole("button", { name: /continue/i });
    expect(next).toBeDisabled();

    await userEvent.click(screen.getByLabelText(/i saved the codes/i));
    await userEvent.click(next);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("«Download» scarica un .txt con tutti i codici", async () => {
    const createObjectURL = vi.fn<(blob: Blob) => string>(() => "blob:codes");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<BackupCodesPanel codes={["aaaaa-bbbbb", "ccccc-ddddd"]} onConfirm={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: /download/i }));

    expect(click).toHaveBeenCalledTimes(1);
    const anchor = click.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(anchor.download).toMatch(/\.txt$/);
    const blob = createObjectURL.mock.calls[0]![0];
    const text = await blob.text();
    expect(text).toContain("aaaaa-bbbbb");
    expect(text).toContain("ccccc-ddddd");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:codes");
    vi.unstubAllGlobals();
  });
});
