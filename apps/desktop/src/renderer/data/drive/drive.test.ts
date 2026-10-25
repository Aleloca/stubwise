import { beforeEach, describe, expect, it } from "vitest";
import { drive, failNext, resetApi, setLatency } from "../api";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import type { DriveOpen } from "../types";
import { isOpenCounted, opens90d, searchableText } from "./content";
import { driveFilesForClaude, readDriveFileForClaude } from "./reads";

const as = (personId: string) => setSessionPersonId(personId);
const AUD = "prj-aud";
const MKX = "prj-mkx";
const STW = "prj-stw";
const MB = 1024 * 1024;

const snapshot = () =>
  JSON.stringify({
    files: state.driveFiles,
    opens: state.driveOpens,
    links: state.folderLinks,
    accounts: state.googleAccounts,
    hidden: [...state.driveHidden],
  });

async function rejects(p: Promise<unknown>, message: string): Promise<void> {
  const before = snapshot();
  await expect(p).rejects.toThrow(message);
  expect(snapshot()).toBe(before);
}

const opensOf = (fileId: string) => state.driveOpens.filter((o) => o.fileId === fileId).length;
const codes = async (projectId: string) =>
  (await drive.listDriveFiles({ projectId, sort: "name" })).map((f) => f.code);

beforeEach(() => {
  resetApi();
  setLatency(0);
  as("p-laura");
});

describe("Drive: conteggio delle aperture (content.ts)", () => {
  const open = (at: string, personId = "p-marco", fileId = "f"): DriveOpen => ({
    fileId,
    personId,
    at,
    via: "preview",
  });

  it("la stessa persona sullo stesso riferimento entro 30 minuti conta una volta", () => {
    expect(isOpenCounted(undefined, open("2026-10-23T10:00:00Z"))).toBe(true);
    expect(isOpenCounted(open("2026-10-23T10:00:00Z"), open("2026-10-23T10:29:59Z"))).toBe(false);
    expect(isOpenCounted(open("2026-10-23T10:00:00Z"), open("2026-10-23T10:30:00Z"))).toBe(true);
  });

  it("un'altra persona, o un altro riferimento, conta sempre", () => {
    const prev = open("2026-10-23T10:00:00Z");
    expect(isOpenCounted(prev, open("2026-10-23T10:05:00Z", "p-laura"))).toBe(true);
    expect(isOpenCounted(prev, open("2026-10-23T10:05:00Z", "p-marco", "g"))).toBe(true);
  });

  it("le aperture degli ultimi 90 giorni: una di 91 giorni fa esce, una di 90 resta", () => {
    const now = "2026-10-23T12:00:00Z";
    const opens = [
      open("2026-07-24T12:00:00Z"), // 91 giorni fa
      open("2026-07-25T12:00:00Z"), // 90 giorni fa
      open("2026-10-22T09:00:00Z"),
      open("2026-10-22T09:00:00Z", "p-marco", "g"),
    ];
    expect(opens90d({ id: "f" }, now, opens)).toBe(2);
  });

  it("il testo cercabile: vuoto per un file non disponibile o non pronto", () => {
    const file = (id: string) => state.driveFiles.find((f) => f.id === id)!;
    expect(searchableText(file("drv-aud-7"))).toContain("30 working days");
    expect(searchableText(file("drv-aud-11"))).toBe("");
    expect(file("drv-aud-11").text).not.toBe("");
    expect(searchableText(file("drv-aud-14"))).toBe("");
  });
});

describe("Drive: visibilità (Review Focus 1)", () => {
  it("un file di un progetto invisibile è identico a uno inesistente in ogni lettura", async () => {
    as("p-sara"); // non vede AUD
    expect(await drive.getDriveFile("drv-aud-7")).toBeNull();
    expect(await drive.getDriveFile("drv-nope")).toBeNull();
    expect(await drive.listDriveFiles({ projectId: AUD, sort: "most_used" })).toEqual([]);
    expect(await drive.listFolderLinks(AUD)).toEqual([]);
    const all = await drive.listDriveFiles({ sort: "name" });
    expect(all.some((f) => f.projectId === AUD || f.projectId === MKX)).toBe(false);
    expect(all.some((f) => f.code === "STW-F1")).toBe(true);
  });

  it("…e in ogni scrittura: not_found, mai forbidden", async () => {
    as("p-sara");
    for (const id of ["drv-aud-7", "drv-nope"]) {
      await rejects(drive.recordOpen(id, "google"), "not_found");
      await rejects(drive.deleteDriveFile(id), "not_found");
      await rejects(drive.removeGoogleFile(id), "not_found");
      await rejects(drive.setHidden(id, true), "not_found");
      await rejects(drive.retryExtraction(id), "not_found");
    }
    await rejects(drive.unlinkFolder("fl-aud-cliente"), "not_found");
    await rejects(drive.unlinkFolder("fl-nope"), "not_found");
    await rejects(drive.syncFolder("fl-aud-cliente"), "not_found");
    await rejects(
      drive.uploadFiles(AUD, [{ name: "a.pdf", mime: "application/pdf", sizeBytes: 10 }]),
      "not_found",
    );
    await rejects(
      drive.uploadFiles("prj-nope", [{ name: "a.pdf", mime: "application/pdf", sizeBytes: 10 }]),
      "not_found",
    );
  });

  it("forbidden solo per un file visibile con un permesso mancante", async () => {
    as("p-marco"); // Developer in AUD: niente drive.manage
    await rejects(drive.setHidden("drv-aud-7", true), "forbidden");
    await rejects(drive.unlinkFolder("fl-aud-cliente"), "forbidden");
    await rejects(drive.deleteDriveFile("drv-aud-3"), "forbidden"); // caricato da Giulia
  });

  it("un nascosto per chi non gestisce non esiste: né in elenco, né per id, né per Claude", async () => {
    as("p-marco");
    expect(await drive.getDriveFile("drv-aud-8")).toBeNull();
    expect(await codes(AUD)).not.toContain("AUD-F8");
    expect(await drive.listDriveFiles({ projectId: AUD, hidden: true, sort: "name" })).toEqual([]);
    await rejects(drive.setHidden("drv-aud-8", false), "not_found");
    await rejects(drive.recordOpen("drv-aud-8", "google"), "not_found");
    expect(readDriveFileForClaude("p-marco", "drv-aud-8")).toBeNull();
  });

  it("chi gestisce vede il nascosto solo nel filtro «Nascosti», con chi l'ha nascosto", async () => {
    expect(await codes(AUD)).not.toContain("AUD-F8");
    const hidden = await drive.listDriveFiles({ projectId: AUD, hidden: true, sort: "name" });
    expect(hidden.map((f) => f.code)).toEqual(["AUD-F8"]);
    expect(hidden[0]!.hiddenBy?.personId).toBe("p-laura");
    expect((await drive.getDriveFile("drv-aud-8"))?.code).toBe("AUD-F8");
  });

  it("Claude legge i file visibili e pronti, mai quelli di un progetto invisibile o non disponibili", () => {
    const laura = driveFilesForClaude("p-laura").map((f) => f.code);
    expect(laura).toContain("AUD-F7");
    expect(laura).not.toContain("AUD-F11"); // non disponibile
    expect(laura).not.toContain("AUD-F8"); // nascosto
    expect(laura).not.toContain("AUD-F14"); // in elaborazione
    expect(readDriveFileForClaude("p-laura", "drv-aud-7")?.text).toContain("30 working days");
    expect(driveFilesForClaude("p-sara").some((f) => f.projectId === AUD)).toBe(false);
    expect(readDriveFileForClaude("p-sara", "drv-aud-7")).toBeNull();
    expect(readDriveFileForClaude("p-sara", "drv-nope")).toBeNull();
  });
});

describe("Drive: elenco e dettaglio", () => {
  it("«Più usati» ordina sulle aperture degli ultimi 90 giorni; la riga porta il numero e la cartella", async () => {
    const rows = await drive.listDriveFiles({ projectId: AUD, sort: "most_used" });
    expect(rows[0]!.code).toBe("AUD-F7");
    expect(rows[0]!.opens90d).toBe(23);
    expect(rows[0]!.folder?.name).toBe("AUD – Cliente");
    expect(rows[0]!.summaryLine).toMatch(/^Framework agreement/);
    expect(rows[0]).not.toHaveProperty("text");
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.opens90d).toBeGreaterThanOrEqual(rows[i]!.opens90d);
    }
  });

  it("Nome e Recenti; filtri per tipo, provenienza e chi l'ha aggiunto", async () => {
    const byName = await drive.listDriveFiles({ projectId: AUD, sort: "name" });
    const names = byName.map((f) => f.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    const recent = await drive.listDriveFiles({ projectId: AUD, sort: "recent" });
    expect(recent[0]!.code).toBe("AUD-F14"); // modificato oggi
    expect(recent.findIndex((f) => f.code === "AUD-F7")).toBeLessThan(
      recent.findIndex((f) => f.code === "AUD-F9"),
    ); // aperto ieri, il preventivo 4 giorni fa
    const pdfs = await drive.listDriveFiles({ projectId: AUD, type: "pdf", sort: "name" });
    expect(pdfs.every((f) => f.type === "pdf")).toBe(true);
    expect(pdfs.length).toBeGreaterThan(0);
    const uploads = await drive.listDriveFiles({ projectId: AUD, source: "upload", sort: "name" });
    expect(uploads.every((f) => f.source === "upload")).toBe(true);
    const byGiulia = await drive.listDriveFiles({
      projectId: AUD,
      addedById: "p-giulia",
      sort: "name",
    });
    expect(byGiulia.every((f) => f.addedById === "p-giulia")).toBe(true);
    expect(byGiulia.map((f) => f.code)).toEqual(
      expect.arrayContaining(["AUD-F3", "AUD-F4", "AUD-F5", "AUD-F12", "AUD-F13"]),
    );
  });

  it("senza progetto: i file di tutti i progetti che vedo", async () => {
    as("p-marco");
    const all = await drive.listDriveFiles({ sort: "name" });
    expect(new Set(all.map((f) => f.projectId))).toEqual(new Set([AUD, STW]));
  });

  it("il dettaglio: totale da sempre e storico solo con drive.history", async () => {
    const laura = await drive.getDriveFile("drv-aud-7");
    expect(laura!.opens90d).toBe(23);
    expect(laura!.opensTotal).toBe(29);
    expect(laura!.history).toHaveLength(29);
    const at = laura!.history!.map((o) => o.at);
    expect(at).toEqual([...at].sort().reverse());
    as("p-marco");
    const marco = await drive.getDriveFile("drv-aud-7");
    expect(marco!.opensTotal).toBe(29);
    expect(marco!.history).toBeNull();
  });

  it("i permessi delle azioni li calcola il server", async () => {
    as("p-marco");
    const own = await drive.getDriveFile("drv-aud-2");
    expect(own!.permissions).toEqual({ delete: true, remove: false, hide: false, retry: false });
    const contract = await drive.getDriveFile("drv-aud-7");
    expect(contract!.permissions).toEqual({
      delete: false,
      remove: false,
      hide: false,
      retry: false,
    });
    as("p-laura");
    const lauraContract = await drive.getDriveFile("drv-aud-7");
    expect(lauraContract!.permissions.hide).toBe(true);
    expect(lauraContract!.permissions.remove).toBe(false); // file di cartella: si nasconde
    expect((await drive.getDriveFile("drv-aud-11"))!.permissions.remove).toBe(true); // non disponibile
  });

  it("le cartelle collegate di un progetto, coi file che portano (nascosti esclusi)", async () => {
    as("p-marco");
    const links = await drive.listFolderLinks(AUD);
    expect(links.map((l) => l.name)).toEqual(["AUD – Cliente"]);
    const visible = state.driveFiles.filter(
      (f) => f.folderLinkId === "fl-aud-cliente" && !f.hidden,
    ).length;
    expect(links[0]!.fileCount).toBe(visible);
  });
});

describe("Drive: aperture (Review Focus 2)", () => {
  it("riaperture entro 30′ contano una; le letture non contano", async () => {
    as("p-marco");
    const before = opensOf("drv-aud-3");
    expect(await drive.recordOpen("drv-aud-3", "preview")).toEqual({ counted: true });
    expect(await drive.recordOpen("drv-aud-3", "download")).toEqual({ counted: false });
    expect(opensOf("drv-aud-3")).toBe(before + 1);
    await drive.listDriveFiles({ projectId: AUD, sort: "most_used" });
    await drive.getDriveFile("drv-aud-3");
    expect(opensOf("drv-aud-3")).toBe(before + 1);
    as("p-laura");
    expect(await drive.recordOpen("drv-aud-3", "preview")).toEqual({ counted: true });
    expect(opensOf("drv-aud-3")).toBe(before + 2);
  });

  it("un'apertura di più di 90 giorni fa resta nel totale ma non sulla riga", async () => {
    const row = (await drive.listDriveFiles({ projectId: AUD, sort: "name" })).find(
      (f) => f.code === "AUD-F1",
    )!;
    expect(row.opens90d).toBe(0);
    expect((await drive.getDriveFile("drv-aud-1"))!.opensTotal).toBe(2);
  });

  it("la lettura di Claude non conta un'apertura", () => {
    const before = state.driveOpens.length;
    driveFilesForClaude("p-laura");
    readDriveFileForClaude("p-laura", "drv-aud-7");
    expect(state.driveOpens.length).toBe(before);
  });

  it("un file in due progetti conta separato", async () => {
    as("p-giulia");
    const aud = opensOf("drv-aud-5");
    const stw = opensOf("drv-stw-1");
    await drive.recordOpen("drv-aud-5", "google");
    expect(opensOf("drv-aud-5")).toBe(aud + 1);
    expect(opensOf("drv-stw-1")).toBe(stw);
  });

  it("un file non disponibile non si apre", async () => {
    await rejects(drive.recordOpen("drv-aud-11", "google"), "unavailable");
  });
});

describe("Drive: caricare, eliminare, togliere", () => {
  it("oltre 100 MB → too_large, gli altri si caricano; il contenuto passa da processing allo stato finale", async () => {
    as("p-marco");
    const results = await drive.uploadFiles(AUD, [
      { name: "export-completo.mov", mime: "video/quicktime", sizeBytes: 101 * MB },
      { name: "Manuale operatore.pdf", mime: "application/pdf", sizeBytes: 99 * MB },
    ]);
    expect(results[0]).toEqual({ name: "export-completo.mov", file: null, error: "too_large" });
    const added = results[1]!.file!;
    expect(added.code).toBe("AUD-F17");
    expect(added.content).toBe("processing");
    expect(added.addedById).toBe("p-marco");
    expect(added.type).toBe("pdf");
    await drive.whenDriveIdle();
    const after = await drive.getDriveFile(added.id);
    expect(after!.content).toBe("ready");
    expect(after!.summary).not.toBeNull();
  });

  it("nome uguale → si tengono entrambi, il nuovo con «(2)»", async () => {
    as("p-marco");
    const results = await drive.uploadFiles(AUD, [
      { name: "Specifiche funzionali dialer v3.pdf", mime: "application/pdf", sizeBytes: 10 },
      { name: "Specifiche funzionali dialer v3.pdf", mime: "application/pdf", sizeBytes: 10 },
    ]);
    expect(results.map((r) => r.file!.name)).toEqual([
      "Specifiche funzionali dialer v3 (2).pdf",
      "Specifiche funzionali dialer v3 (3).pdf",
    ]);
    expect((await codes(AUD)).filter((c) => c === "AUD-F2")).toHaveLength(1);
  });

  it("senza drive.upload: forbidden", async () => {
    as("p-sara");
    const { revokeProjectPermission } = await import("../viewer");
    revokeProjectPermission("p-sara", STW, "drive.upload");
    await rejects(
      drive.uploadFiles(STW, [{ name: "a.pdf", mime: "application/pdf", sizeBytes: 1 }]),
      "forbidden",
    );
  });

  it("l'estrazione simulata fallita → error, e «Riprova» (drive.manage) la riporta pronta", async () => {
    as("p-marco");
    failNext("drive.advanceContent");
    const [r] = await drive.uploadFiles(AUD, [
      { name: "note.md", mime: "text/markdown", sizeBytes: 100 },
    ]);
    await drive.whenDriveIdle();
    expect((await drive.getDriveFile(r!.file!.id))!.content).toBe("error");
    await rejects(drive.retryExtraction(r!.file!.id), "forbidden");
    as("p-laura");
    expect((await drive.retryExtraction(r!.file!.id)).content).toBe("processing");
    await drive.whenDriveIdle();
    expect((await drive.getDriveFile(r!.file!.id))!.content).toBe("ready");
    expect(drive.driveContentHistory(r!.file!.id)).toEqual([
      "processing",
      "error",
      "processing",
      "ready",
    ]);
  });

  it("eliminare il proprio caricato toglie anche le sue aperture; il codice non si riusa", async () => {
    as("p-marco");
    await drive.deleteDriveFile("drv-aud-2");
    expect(state.driveFiles.some((f) => f.id === "drv-aud-2")).toBe(false);
    expect(opensOf("drv-aud-2")).toBe(0);
    const [r] = await drive.uploadFiles(AUD, [
      { name: "x.pdf", mime: "application/pdf", sizeBytes: 1 },
    ]);
    expect(r!.file!.code).toBe("AUD-F17");
    await drive.deleteDriveFile(r!.file!.id);
    const [again] = await drive.uploadFiles(AUD, [
      { name: "y.pdf", mime: "application/pdf", sizeBytes: 1 },
    ]);
    expect(again!.file!.code).toBe("AUD-F18");
  });

  it("un Google non si elimina: si toglie; un file di cartella si nasconde (use_hide)", async () => {
    await rejects(drive.deleteDriveFile("drv-aud-5"), "invalid");
    await rejects(drive.removeGoogleFile("drv-aud-7"), "use_hide");
    await rejects(drive.removeGoogleFile("drv-aud-2"), "invalid");
    await drive.removeGoogleFile("drv-aud-11"); // di cartella ma non disponibile: si toglie
    expect(state.driveFiles.some((f) => f.id === "drv-aud-11")).toBe(false);
  });

  it("togliere un Google: chi l'ha aggiunto o drive.manage", async () => {
    as("p-marco");
    await rejects(drive.removeGoogleFile("drv-aud-5"), "forbidden"); // aggiunto da Giulia
    as("p-giulia");
    await drive.removeGoogleFile("drv-aud-5");
    expect(state.driveFiles.some((f) => f.id === "drv-aud-5")).toBe(false);
    expect(state.driveFiles.some((f) => f.id === "drv-stw-1")).toBe(true);
  });
});

describe("Drive: nascondere e cartelle (Review Focus 4)", () => {
  it("nascosto e risincronizzato non torna; rimostrato torna col suo codice e il suo conteggio", async () => {
    const before = (await drive.getDriveFile("drv-aud-9"))!;
    await drive.setHidden("drv-aud-9", true);
    expect(await codes(AUD)).not.toContain("AUD-F9");
    await drive.syncFolder("fl-aud-cliente");
    await drive.whenDriveIdle();
    expect(await codes(AUD)).not.toContain("AUD-F9");
    expect(
      state.driveFiles.filter((f) => f.googleFileId === before.googleFileId && f.projectId === AUD),
    ).toHaveLength(1);
    await drive.setHidden("drv-aud-9", false);
    const back = (await drive.listDriveFiles({ projectId: AUD, sort: "name" })).find(
      (f) => f.id === "drv-aud-9",
    )!;
    expect(back.code).toBe("AUD-F9");
    expect(back.opens90d).toBe(before.opens90d);
    expect(back.hiddenBy).toBeNull();
  });

  it("si nasconde solo un file di cartella", async () => {
    await rejects(drive.setHidden("drv-aud-2", true), "invalid");
    await rejects(drive.setHidden("drv-aud-5", true), "invalid");
  });

  it("scollegare una cartella toglie i suoi file (e le loro aperture), i caricati restano", async () => {
    const folderIds = state.driveFiles
      .filter((f) => f.folderLinkId === "fl-aud-cliente")
      .map((f) => f.id);
    await drive.unlinkFolder("fl-aud-cliente");
    const left = await drive.listDriveFiles({ projectId: AUD, sort: "name" });
    expect(left.some((f) => f.folder !== null)).toBe(false);
    expect(left.map((f) => f.code)).toEqual(
      expect.arrayContaining(["AUD-F1", "AUD-F2", "AUD-F3", "AUD-F4", "AUD-F5", "AUD-F15"]),
    );
    for (const id of folderIds) expect(opensOf(id)).toBe(0);
    expect(await drive.listFolderLinks(AUD)).toEqual([]);
  });

  it("ricollegarla: i file ripartono da zero, con codici nuovi; il cancellato su Google non torna", async () => {
    await drive.unlinkFolder("fl-aud-cliente");
    await rejects(drive.linkFolder(AUD, "gfolder-aud-cliente"), "google_not_connected"); // account scaduto
    await drive.connectGoogle();
    const link = await drive.linkFolder(AUD, "gfolder-aud-cliente");
    expect(link.linkedById).toBe("p-laura");
    await drive.whenDriveIdle();
    const rows = (await drive.listDriveFiles({ projectId: AUD, sort: "name" })).filter(
      (f) => f.folder?.id === link.id,
    );
    expect(rows.length).toBe(link.fileCount);
    for (const f of rows) {
      expect(f.opens90d).toBe(0);
      expect(drive.driveContentHistory(f.id)[0]).toBe("processing");
    }
    expect(rows.some((f) => f.name === "Requisiti integrazione CRM cliente")).toBe(false);
    expect(rows.map((f) => f.code)).not.toContain("AUD-F7");
    expect(rows.every((f) => Number(f.code.slice(5)) > 16)).toBe(true);
    const contract = (await drive.listDriveFiles({ projectId: AUD, sort: "name" })).find(
      (f) => f.name === "Contratto quadro Audin 2025",
    )!;
    expect(contract.content).toBe("ready");
    expect(contract.addedById).toBe("p-laura");
  });

  it("collegare: drive.manage, cartella visibile all'account, una volta sola per progetto", async () => {
    as("p-giulia");
    await rejects(drive.linkFolder(AUD, "gfolder-bellavista"), "forbidden"); // Contributor in AUD
    await rejects(drive.linkFolder(MKX, "gfolder-nope"), "not_found");
    const link = await drive.linkFolder(MKX, "gfolder-bellavista");
    expect(link.status).toBe("ok");
    await rejects(drive.linkFolder(MKX, "gfolder-bellavista"), "already_linked");
    const folders = await drive.listGoogleFolders(MKX);
    expect(folders.find((f) => f.googleFolderId === "gfolder-bellavista")?.alreadyLinked).toBe(
      true,
    );
    await drive.whenDriveIdle();
    const added = (await drive.listDriveFiles({ projectId: MKX, sort: "name" })).filter(
      (f) => f.folder?.id === link.id,
    );
    expect(added).toHaveLength(3);
    expect(added.find((f) => f.name === "Logo Cantina Bellavista.png")?.content).toBe("no_text");
  });

  it("sincronizzare: il file «aggiornato su Google» torna in elaborazione, poi pronto col testo nuovo", async () => {
    const before = (await drive.getDriveFile("drv-aud-9"))!;
    // Con latenza il passo simulato arriva dopo la risposta di «Sincronizza ora».
    setLatency(5);
    await drive.syncFolder("fl-aud-cliente");
    // Subito dopo: in elaborazione, col riassunto in rielaborazione (cercabile solo per nome).
    const during = state.driveFiles.find((f) => f.id === "drv-aud-9")!;
    expect(during.content).toBe("processing");
    expect(during.summary).toBeNull();
    expect(searchableText(during)).toBe("");
    await drive.whenDriveIdle();
    const after = (await drive.getDriveFile("drv-aud-9"))!;
    expect(after.content).toBe("ready");
    expect(after.summary).toMatch(/^Updated quote/);
    expect(after.modifiedAt > before.modifiedAt).toBe(true);
    expect(after.opensTotal).toBe(before.opensTotal);
    expect(drive.driveContentHistory("drv-aud-9")).toEqual(["processing", "ready"]);
    expect((await drive.getDriveFile("drv-aud-14"))!.content).toBe("ready");
    // Il contratto non è cambiato su Google: non si rilegge.
    expect(drive.driveContentHistory("drv-aud-7")).toEqual([]);
  });

  it("una cartella scaduta non si sincronizza", async () => {
    await rejects(drive.syncFolder("fl-stw-brand"), "link_expired");
  });
});

describe("Drive: account Google", () => {
  it("l'account di chi guarda: collegato, scaduto o nessuno", async () => {
    as("p-giulia");
    expect((await drive.getGoogleAccount())?.status).toBe("connected");
    as("p-laura");
    expect((await drive.getGoogleAccount())?.status).toBe("expired");
    as("p-marco");
    expect(await drive.getGoogleAccount()).toBeNull();
  });

  it("file fuori dai progetti: solo con l'account collegato e se li vedo su Google", async () => {
    as("p-giulia");
    expect((await drive.listGoogleOutside("")).map((f) => f.name).sort()).toEqual([
      "Moodboard autunno 2026",
      "Offerta Cantina Bellavista – bozza",
    ]);
    expect((await drive.listGoogleOutside("wine club")).map((f) => f.name)).toEqual([
      "Offerta Cantina Bellavista – bozza",
    ]);
    as("p-laura"); // scaduto
    expect(await drive.listGoogleOutside("")).toEqual([]);
    as("p-marco"); // nessun account
    expect(await drive.listGoogleOutside("")).toEqual([]);
  });

  it("aggiungere un file Google: un riferimento nuovo, che non è più «fuori»", async () => {
    as("p-giulia");
    const added = await drive.addGoogleFile(AUD, "gfile-out-bellavista-offer");
    expect(added.code).toBe("AUD-F17");
    expect(added.addedById).toBe("p-giulia");
    expect(added.folder).toBeNull();
    expect((await drive.listGoogleOutside("")).map((f) => f.name)).toEqual([
      "Moodboard autunno 2026",
    ]);
    await rejects(drive.addGoogleFile(AUD, "gfile-out-bellavista-offer"), "already_in_project");
    await rejects(drive.addGoogleFile(AUD, "gfile-nope"), "not_found");
    const choices = await drive.listGoogleFiles(AUD, "");
    expect(
      choices.find((c) => c.googleFileId === "gfile-out-bellavista-offer")?.alreadyInProject,
    ).toBe(true);
    as("p-marco");
    await rejects(drive.addGoogleFile(AUD, "gfile-out-moodboard-autunno"), "google_not_connected");
  });

  it("lo stesso file Google in un altro progetto è un riferimento nuovo, con un codice nuovo", async () => {
    as("p-giulia");
    const added = await drive.addGoogleFile(MKX, "gfile-roadmap-q4-2026");
    expect(added.code).toMatch(/^MKX-F\d+$/);
    expect(added.opens90d).toBe(0);
  });

  it("disconnettersi rende non disponibili i file delle cartelle collegate da me; ricollegarsi li riporta", async () => {
    as("p-giulia");
    await drive.disconnectGoogle();
    expect(await drive.getGoogleAccount()).toBeNull();
    const folder = state.driveFiles.filter((f) => f.folderLinkId === "fl-mkx-primavera");
    expect(folder.every((f) => f.unavailable === "access_lost")).toBe(true);
    expect(state.folderLinks.find((l) => l.id === "fl-mkx-primavera")?.status).toBe("expired");
    expect(await drive.listGoogleOutside("")).toEqual([]);
    await drive.connectGoogle();
    expect((await drive.getGoogleAccount())?.email).toBe("giulia.ferri@example.com");
    expect(
      state.driveFiles
        .filter((f) => f.folderLinkId === "fl-mkx-primavera")
        .every((f) => f.unavailable === null),
    ).toBe(true);
    expect(state.folderLinks.find((l) => l.id === "fl-mkx-primavera")?.status).toBe("ok");
  });

  it("collegarsi senza account crea l'account con l'email della persona", async () => {
    as("p-marco");
    const account = await drive.connectGoogle();
    expect(account).toEqual({
      personId: "p-marco",
      email: "marco.bellini@example.com",
      status: "connected",
    });
  });
});

describe("Drive: ripristino", () => {
  it("resetApi riporta il seme, sequenza dei codici compresa", async () => {
    as("p-marco");
    await drive.uploadFiles(AUD, [{ name: "x.pdf", mime: "application/pdf", sizeBytes: 1 }]);
    await drive.deleteDriveFile("drv-aud-2");
    resetApi();
    setLatency(0);
    as("p-marco");
    expect(state.driveFiles.some((f) => f.id === "drv-aud-2")).toBe(true);
    const [r] = await drive.uploadFiles(AUD, [
      { name: "x.pdf", mime: "application/pdf", sizeBytes: 1 },
    ]);
    expect(r!.file!.code).toBe("AUD-F17");
  });
});

describe("Drive: fix round 1", () => {
  it("un file fuori dai progetti resta «fuori» per chi non vede il progetto in cui è entrato (R-G5)", async () => {
    // Marco non è in MKX: vede il moodboard su Google, con l'account collegato.
    state.googleOutside
      .find((f) => f.name === "Moodboard autunno 2026")!
      .visibleToPersonIds.push("p-marco");
    as("p-marco");
    await drive.connectGoogle();
    as("p-giulia");
    await drive.addGoogleFile(MKX, "gfile-out-moodboard-autunno");
    expect((await drive.listGoogleOutside("")).map((f) => f.name)).not.toContain(
      "Moodboard autunno 2026",
    );
    as("p-marco");
    expect((await drive.listGoogleOutside("")).map((f) => f.name)).toContain(
      "Moodboard autunno 2026",
    );
  });

  it("i file del seme in elaborazione finiscono dopo la prima lettura (niente attesa senza fine)", async () => {
    expect(state.driveFiles.find((f) => f.id === "drv-aud-12")!.content).toBe("processing");
    await drive.listDriveFiles({ projectId: AUD, sort: "name" });
    await drive.whenDriveIdle();
    expect(state.driveFiles.some((f) => f.content === "processing")).toBe(false);
    expect(drive.driveContentHistory("drv-aud-12")).toEqual(["no_text"]);
    expect((await drive.getDriveFile("drv-aud-14"))!.content).toBe("ready");
    // Una volta sola per stato: una seconda lettura non riparte.
    await drive.listDriveFiles({ projectId: AUD, sort: "name" });
    await drive.whenDriveIdle();
    expect(drive.driveContentHistory("drv-aud-12")).toEqual(["no_text"]);
  });

  it("sincronizzare una cartella il cui account non è collegato la segna scaduta, senza leggerla", async () => {
    state.googleAccounts.find((a) => a.personId === "p-matteo")!.status = "expired";
    const link = await drive.syncFolder("fl-aud-cliente");
    expect(link.status).toBe("expired");
    expect(state.folderLinks.find((l) => l.id === "fl-aud-cliente")!.status).toBe("expired");
    await drive.whenDriveIdle();
    expect(drive.driveContentHistory("drv-aud-9")).toEqual([]);
    await rejects(drive.syncFolder("fl-aud-cliente"), "link_expired");
  });

  it("il dettaglio si apre anche per codice (`?file=AUD-F7`), con la stessa regola di visibilità", async () => {
    expect((await drive.getDriveFile("AUD-F7"))!.id).toBe("drv-aud-7");
    as("p-sara"); // non vede AUD: per codice come per id, non esiste
    expect(await drive.getDriveFile("AUD-F7")).toBeNull();
    as("p-marco"); // un nascosto, per chi non gestisce, non ha codice
    expect(await drive.getDriveFile("AUD-F8")).toBeNull();
    expect(await drive.getDriveFile("AUD-F999")).toBeNull();
  });
});
