// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  isExternalOpenAllowed,
  isNavigationAllowed,
  MAX_SAVE_BYTES,
  parseSaveFileRequest,
  PRODUCTION_CSP,
  safeFileName,
  saveFilterFor,
  withExtension,
} from "./security";

const packagedUrl = "file:///Applications/Stubwise.app/out/renderer/index.html";

describe("isNavigationAllowed", () => {
  it("in dev ammette solo l'origine del dev server", () => {
    const o = { devUrl: "http://localhost:5173", packagedUrl };
    expect(isNavigationAllowed("http://localhost:5173/#/home", o)).toBe(true);
    expect(isNavigationAllowed("http://localhost:5174/", o)).toBe(false);
    expect(isNavigationAllowed("https://example.com/", o)).toBe(false);
    expect(isNavigationAllowed(packagedUrl, o)).toBe(false);
  });
  it("impacchettato ammette solo lo stesso file (l'hash cambia)", () => {
    expect(isNavigationAllowed(`${packagedUrl}#/p/STW`, { packagedUrl })).toBe(true);
    expect(isNavigationAllowed("file:///etc/passwd", { packagedUrl })).toBe(false);
    expect(isNavigationAllowed("https://example.com/", { packagedUrl })).toBe(false);
    expect(isNavigationAllowed("javascript:alert(1)", { packagedUrl })).toBe(false);
    expect(isNavigationAllowed("non un url", { packagedUrl })).toBe(false);
  });
});

describe("isExternalOpenAllowed", () => {
  it("lascia uscire solo http(s)", () => {
    expect(isExternalOpenAllowed("https://stubwise.dev")).toBe(true);
    expect(isExternalOpenAllowed("http://example.com")).toBe(true);
    expect(isExternalOpenAllowed("file:///etc/passwd")).toBe(false);
    expect(isExternalOpenAllowed("smb://host/share")).toBe(false);
    expect(isExternalOpenAllowed("nonsense")).toBe(false);
  });
});

describe("PRODUCTION_CSP", () => {
  it("vieta oggetti e base, e non ammette script inline né eval", () => {
    expect(PRODUCTION_CSP).toContain("object-src 'none'");
    expect(PRODUCTION_CSP).toContain("base-uri 'none'");
    expect(PRODUCTION_CSP).toMatch(/script-src 'self'(;|$)/);
    expect(PRODUCTION_CSP).not.toContain("unsafe-eval");
  });
});

// Il solo canale IPC nuovo dell'area 11a (`file:save`, decisione 8 della
// spec): la validazione è pura, qui; il processo principale la chiama prima
// di ogni altra cosa e non scrive mai senza la finestra di salvataggio.

describe("file:save — parseSaveFileRequest", () => {
  const zip = (n = 8) => {
    const data = new Uint8Array(n);
    data.set([0x50, 0x4b, 0x03, 0x04]);
    return data;
  };

  it("accetta un PDF col solo nome, e un Word coi byte di uno zip", () => {
    expect(parseSaveFileRequest({ format: "pdf", name: "x" })).toEqual({ format: "pdf", name: "x" });
    const data = zip();
    expect(parseSaveFileRequest({ format: "docx", name: "ACQ Product", data })).toEqual({
      format: "docx",
      name: "ACQ Product",
      data,
    });
  });

  it("rifiuta formato ignoto, nome vuoto o lungo, dati assenti, estranei o troppo grandi, campi in più", () => {
    const rejected: unknown[] = [
      null,
      "pdf",
      { format: "exe", name: "x" },
      { format: "pdf" },
      { format: "pdf", name: "" },
      { format: "pdf", name: "   " },
      { format: "pdf", name: 42 },
      { format: "pdf", name: "x".repeat(121) },
      { format: "pdf", name: "x", path: "/etc/passwd" },
      { format: "pdf", name: "x", data: zip() },
      { format: "docx", name: "x" },
      { format: "docx", name: "x", data: "UEsDBA==" },
      { format: "docx", name: "x", data: [0x50, 0x4b, 0x03, 0x04] },
      { format: "docx", name: "x", data: new Uint8Array(0) },
      // I byte di un PDF in un Word: non è uno zip.
      { format: "docx", name: "x", data: new Uint8Array([0x25, 0x50, 0x44, 0x46]) },
      { format: "docx", name: "x", data: zip(MAX_SAVE_BYTES + 1) },
      { format: "docx", name: "x", data: zip(26 * 1024 * 1024) },
    ];
    for (const v of rejected) expect(parseSaveFileRequest(v)).toBeNull();
    expect(parseSaveFileRequest({ format: "pdf", name: "x".repeat(120) })).not.toBeNull();
    expect(parseSaveFileRequest({ format: "docx", name: "x", data: zip(MAX_SAVE_BYTES) })).not.toBeNull();
  });
});

describe("file:save — safeFileName, saveFilterFor, withExtension", () => {
  it("un nome di file, mai un percorso", () => {
    expect(safeFileName("Fatture 2026/27: regole", "pdf")).toBe("Fatture 2026-27- regole.pdf");
    const passwd = safeFileName("../../etc/passwd", "pdf");
    expect(passwd).not.toContain("/");
    expect(passwd).not.toContain("..");
    expect(passwd.endsWith(".pdf")).toBe(true);
    expect(safeFileName('a\\b<c>d"e|f?g*h', "docx")).toBe("a-b-c-d-e-f-g-h.docx");
    expect(safeFileName("report.pdf", "docx")).toBe("report.pdf.docx");
    expect(safeFileName("report.PDF", "pdf")).toBe("report.PDF");
    expect(safeFileName("ACQ-D5\u0000 Sign\u0007-in\u001f", "pdf")).toBe("ACQ-D5 Sign-in.pdf");
    expect(safeFileName("  ACQ   Product  ", "docx")).toBe("ACQ Product.docx");
    expect(safeFileName("\u0001\u0002", "pdf")).toBe("Stubwise export.pdf");
    expect(safeFileName("..", "docx")).toBe("Stubwise export.docx");
  });

  it("il filtro della finestra e l'estensione del percorso scelto", () => {
    expect(saveFilterFor("pdf")).toEqual({ name: "PDF", extensions: ["pdf"] });
    expect(saveFilterFor("docx")).toEqual({ name: "Word", extensions: ["docx"] });
    expect(withExtension("/Users/x/Desktop/Sign-in", "docx")).toBe("/Users/x/Desktop/Sign-in.docx");
    expect(withExtension("/Users/x/Desktop/Sign-in.DOCX", "docx")).toBe("/Users/x/Desktop/Sign-in.DOCX");
    expect(withExtension("C:\\Users\\x\\Sign-in.pdf", "pdf")).toBe("C:\\Users\\x\\Sign-in.pdf");
    expect(withExtension("/tmp/report.pdf", "docx")).toBe("/tmp/report.pdf.docx");
  });
});
