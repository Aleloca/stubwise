// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  isExternalOpenAllowed,
  isNavigationAllowed,
  MAX_SAVE_BYTES,
  parseSaveFileRequest,
  PRODUCTION_CSP,
  refusedDebugSwitch,
  appContentType,
  appFilePath,
  bridgeAllowed,
  rendererDevUrl,
  webPreferencesFor,
  safeFileName,
  saveFilterFor,
  withExtension,
} from "./security";

// Dal protocollo dell'app (seconda revisione, dopo M5): il renderer
// impacchettato si serve da `app://stubwise/`, non più da `file://`, così la
// fuse `grantFileProtocolExtraPrivileges` si spegne.
const packagedUrl = "app://stubwise/index.html";
const fileUrl =
  "file:///Applications/Stubwise.app/Contents/Resources/app.asar/out/renderer/index.html";

describe("isNavigationAllowed", () => {
  it("in dev ammette solo l'origine del dev server", () => {
    const o = { devUrl: "http://localhost:5173" };
    expect(isNavigationAllowed("http://localhost:5173/#/home", o)).toBe(true);
    expect(isNavigationAllowed("http://localhost:5174/", o)).toBe(false);
    expect(isNavigationAllowed("https://example.com/", o)).toBe(false);
    expect(isNavigationAllowed(packagedUrl, o)).toBe(false);
  });
  it("impacchettato ammette solo app://stubwise/index.html (l'hash cambia); file:// mai", () => {
    expect(isNavigationAllowed(`${packagedUrl}#/p/STW`, {})).toBe(true);
    expect(isNavigationAllowed(fileUrl, {})).toBe(false);
    expect(isNavigationAllowed("app://stubwise/other.html", {})).toBe(false);
    expect(isNavigationAllowed("app://altro/index.html", {})).toBe(false);
    expect(isNavigationAllowed("file:///etc/passwd", {})).toBe(false);
    expect(isNavigationAllowed("https://example.com/", {})).toBe(false);
    expect(isNavigationAllowed("javascript:alert(1)", {})).toBe(false);
    expect(isNavigationAllowed("non un url", {})).toBe(false);
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
    expect(parseSaveFileRequest({ format: "pdf", name: "x" })).toEqual({
      format: "pdf",
      name: "x",
    });
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
    expect(
      parseSaveFileRequest({ format: "docx", name: "x", data: zip(MAX_SAVE_BYTES) }),
    ).not.toBeNull();
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
    expect(withExtension("/Users/x/Desktop/Sign-in.DOCX", "docx")).toBe(
      "/Users/x/Desktop/Sign-in.DOCX",
    );
    expect(withExtension("C:\\Users\\x\\Sign-in.pdf", "pdf")).toBe("C:\\Users\\x\\Sign-in.pdf");
    expect(withExtension("/tmp/report.pdf", "docx")).toBe("/tmp/report.pdf.docx");
  });
});

// Seconda revisione di sicurezza della cassaforte, C1: nel pacchetto
// `ELECTRON_RENDERER_URL` non conta. Rilanciando l'app con quella env, una
// pagina qualunque riceverebbe il bridge intero (cassaforte, `api:request`
// col PAT) e la navigazione verso la sua origine sarebbe permessa.
describe("rendererDevUrl (C1)", () => {
  const env = { ELECTRON_RENDERER_URL: "http://attacker.example:5173" };
  it("nel pacchetto è sempre assente, qualunque sia l'env", () => {
    expect(rendererDevUrl({ isPackaged: true, env })).toBeUndefined();
  });
  it("in sviluppo è quella del dev server", () => {
    expect(rendererDevUrl({ isPackaged: false, env })).toBe("http://attacker.example:5173");
    expect(rendererDevUrl({ isPackaged: false, env: {} })).toBeUndefined();
  });
  it("e senza devUrl la navigazione resta sul file impacchettato", () => {
    const devUrl = rendererDevUrl({ isPackaged: true, env });
    expect(isNavigationAllowed("http://attacker.example:5173/", { devUrl })).toBe(false);
  });
});

// C2: nessun fuse copre il debug remoto di Chromium. Nel pacchetto, con
// `--remote-debugging-port` o `--remote-debugging-pipe`, l'app esce prima di
// aprire una finestra: chi vi si attaccasse leggerebbe la cassaforte aperta.
describe("refusedDebugSwitch (C2)", () => {
  const has =
    (...on: string[]) =>
    (name: string) =>
      on.includes(name);
  it("nel pacchetto rifiuta il debug remoto, per porta o per pipe", () => {
    expect(refusedDebugSwitch({ isPackaged: true, hasSwitch: has("remote-debugging-port") })).toBe(
      "remote-debugging-port",
    );
    expect(refusedDebugSwitch({ isPackaged: true, hasSwitch: has("remote-debugging-pipe") })).toBe(
      "remote-debugging-pipe",
    );
    expect(refusedDebugSwitch({ isPackaged: true, hasSwitch: has("lang") })).toBeNull();
  });
  it("in sviluppo li lascia passare", () => {
    expect(
      refusedDebugSwitch({ isPackaged: false, hasSwitch: has("remote-debugging-port") }),
    ).toBeNull();
  });
});

// M6: i DevTools solo in sviluppo; il resto dell'isolamento non cambia.
describe("webPreferencesFor (M6)", () => {
  it("nel pacchetto niente DevTools; isolamento e sandbox sempre", () => {
    const packaged = webPreferencesFor({ isPackaged: true, preload: "/p.cjs" });
    expect(packaged).toEqual({
      preload: "/p.cjs",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
      additionalArguments: [],
    });
    expect(webPreferencesFor({ isPackaged: false, preload: "/p.cjs" }).devTools).toBe(true);
    // Il dev server lo sa il preload da un argomento (il bridge si espone solo a lui o ad app://).
    expect(
      webPreferencesFor({
        isPackaged: false,
        preload: "/p.cjs",
        devOrigin: "http://localhost:5173",
      }).additionalArguments,
    ).toEqual(["--stubwise-dev-origin=http://localhost:5173"]);
  });
});

// Il protocollo dell'app: serve SOLO i file del renderer impacchettato.
describe("appFilePath (app://)", () => {
  const root = "/App/Contents/Resources/app.asar/out/renderer";
  it("i file del renderer, la radice è index.html", () => {
    expect(appFilePath("app://stubwise/index.html", root)).toBe(`${root}/index.html`);
    expect(appFilePath("app://stubwise/", root)).toBe(`${root}/index.html`);
    expect(appFilePath("app://stubwise/assets/index-1.js?x=1#y", root)).toBe(
      `${root}/assets/index-1.js`,
    );
    expect(appFilePath("app://stubwise/assets/a%20b.css", root)).toBe(`${root}/assets/a b.css`);
  });
  it("niente fuori dalla radice, niente altri host o schemi", () => {
    for (const bad of [
      "app://stubwise/../../../etc/passwd",
      "app://stubwise/%2e%2e/%2e%2e/etc/passwd",
      "app://stubwise/assets/..%2f..%2f..%2fetc%2fpasswd",
      "app://stubwise//etc/passwd",
      "app://altro/index.html",
      "file:///etc/passwd",
      "non un url",
    ])
      expect(appFilePath(bad, root), bad).toBeNull();
  });
});

// Il bridge (`window.stubwise`) si espone solo alla pagina dell'app: una
// pagina file:// (o qualunque altra) che finisse nella finestra non lo riceve.
describe("bridgeAllowed (preload)", () => {
  it("app://stubwise sì; file://, http esterni e un altro host app:// no", () => {
    expect(bridgeAllowed("app://stubwise/index.html#/home", undefined)).toBe(true);
    expect(bridgeAllowed(fileUrl, undefined)).toBe(false);
    expect(bridgeAllowed("https://example.com/", undefined)).toBe(false);
    expect(bridgeAllowed("app://altro/index.html", undefined)).toBe(false);
  });
  it("in sviluppo anche il dev server, e solo lui", () => {
    expect(bridgeAllowed("http://localhost:5173/#/home", "http://localhost:5173")).toBe(true);
    expect(bridgeAllowed("http://localhost:5174/", "http://localhost:5173")).toBe(false);
    expect(bridgeAllowed(fileUrl, "http://localhost:5173")).toBe(false);
  });
});

describe("appContentType (app://)", () => {
  it("il tipo dall'estensione; uno sconosciuto non si indovina", () => {
    expect(appContentType("/r/index.html")).toBe("text/html; charset=utf-8");
    expect(appContentType("/r/assets/a.js")).toBe("text/javascript; charset=utf-8");
    expect(appContentType("/r/assets/a.css")).toBe("text/css; charset=utf-8");
    expect(appContentType("/r/assets/f.woff2")).toBe("font/woff2");
    expect(appContentType("/r/assets/i.svg")).toBe("image/svg+xml");
    expect(appContentType("/r/assets/x.bin")).toBe("application/octet-stream");
  });
});
