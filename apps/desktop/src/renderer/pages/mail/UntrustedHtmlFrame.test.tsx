import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import "../../i18n";
import { MAX_FRAME_IMAGES, UntrustedHtmlFrame } from "./UntrustedHtmlFrame";

// «Show images» dal proxy del server (design delle immagini della posta, §6):
// per posizione, al più 50 e 4 insieme, solo come data:, mai dal mittente.

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const imgs = (n: number) =>
  Array.from({ length: n }, (_, i) => `<img data-image="${i}" data-src="https://a.example/${i}.png" alt="img ${i}">`).join("");
const srcdoc = () => screen.getByTitle("Email").getAttribute("srcdoc") ?? "";

describe("UntrustedHtmlFrame, le immagini", () => {
  it("senza chi le carica (il calendario) il bottone non c'è; la frase sì", () => {
    render(<UntrustedHtmlFrame html={imgs(2)} title="Email" />);
    expect(screen.getByText("Remote images are blocked to protect your privacy.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show images" })).toBeNull();
  });

  it("al più 50, 4 insieme; quelle che non arrivano restano senza src (con l'alt); oltre 50 lo dice", async () => {
    const asked: number[] = [];
    let inFlight = 0;
    let peak = 0;
    const loadImage = async (n: number) => {
      asked.push(n);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return n === 3 ? null : PNG;
    };
    render(<UntrustedHtmlFrame html={imgs(52)} title="Email" loadImage={loadImage} />);
    await userEvent.click(screen.getByRole("button", { name: "Show images" }));
    await waitFor(() => expect(srcdoc()).toContain(`src="${PNG}"`));
    expect(asked).toHaveLength(MAX_FRAME_IMAGES);
    expect(peak).toBeLessThanOrEqual(4);
    const doc = new DOMParser().parseFromString(srcdoc(), "text/html");
    const img3 = doc.querySelector('img[data-image="3"]')!;
    expect(img3.getAttribute("src")).toBeNull();
    expect(img3.getAttribute("alt")).toBe("img 3");
    expect(doc.querySelector('img[data-image="51"]')!.getAttribute("src")).toBeNull();
    expect(screen.getByText("Only the first 50 images are shown.")).toBeInTheDocument();
    expect(srcdoc()).not.toMatch(/\ssrc="https?:/);
  });
});
