import { describe, expect, it } from "vitest";
import { isAppRoute, isValidSearchParam } from "../../data/routes";
import {
  driveFiltersFrom,
  hasDriveFilter,
  isDriveSearchValue,
  middleEllipsis,
  previewKind,
} from "./driveFilters";

describe("Drive: filtri e ordinamento nell'indirizzo", () => {
  it("valori validi e malformati", () => {
    expect(isDriveSearchValue("sort", "recent")).toBe(true);
    expect(isDriveSearchValue("sort", "most_used")).toBe(true);
    expect(isDriveSearchValue("sort", "size")).toBe(false);
    expect(isDriveSearchValue("type", "pdf")).toBe(true);
    expect(isDriveSearchValue("type", "video")).toBe(false);
    expect(isDriveSearchValue("source", "google")).toBe(true);
    expect(isDriveSearchValue("source", "dropbox")).toBe(false);
    expect(isDriveSearchValue("addedBy", "p-marco")).toBe(true);
    expect(isDriveSearchValue("addedBy", "p marco")).toBe(false);
    expect(isDriveSearchValue("prj", "AUD")).toBe(true);
    expect(isDriveSearchValue("prj", "aud")).toBe(false);
  });

  it("valgono solo sul Drive; `file` ovunque, come `task`", () => {
    expect(isAppRoute("#/p/AUD/drive?sort=name&type=pdf")).toBe(true);
    expect(isAppRoute("#/drive?prj=AUD&source=google")).toBe(true);
    expect(isAppRoute("#/drive")).toBe(true);
    expect(isValidSearchParam("p/AUD/tasks", "sort", "name")).toBe(false);
    expect(isValidSearchParam("p/AUD/drive", "prj", "AUD")).toBe(false);
    expect(isValidSearchParam("home", "file", "AUD-F7")).toBe(true);
    expect(isValidSearchParam("home", "file", "AUD-7")).toBe(false);
  });

  it("dalla ricerca ai filtri dell'elenco: «Più usati» di default, progetto per codice", () => {
    const codeToId = (code: string) => (code === "AUD" ? "prj-aud" : undefined);
    expect(driveFiltersFrom({}, { codeToId })).toEqual({ sort: "most_used" });
    expect(
      driveFiltersFrom(
        { sort: "name", type: "pdf", source: "upload", addedBy: "p-marco", prj: "AUD" },
        { codeToId },
      ),
    ).toEqual({
      sort: "name",
      type: "pdf",
      source: "upload",
      addedById: "p-marco",
      projectId: "prj-aud",
    });
    // Il progetto della sezione vince sul filtro (che lì non esiste).
    expect(driveFiltersFrom({ prj: "MKX" }, { codeToId, projectId: "prj-aud" }).projectId).toBe(
      "prj-aud",
    );
    // Un valore malformato si scarta.
    expect(driveFiltersFrom({ sort: "size", type: "video" }, { codeToId })).toEqual({
      sort: "most_used",
    });
  });

  it("c'è un filtro: l'ordinamento non conta", () => {
    expect(hasDriveFilter({ sort: "name" })).toBe(false);
    expect(hasDriveFilter({ type: "pdf" })).toBe(true);
    expect(hasDriveFilter({ prj: "AUD" })).toBe(true);
  });
});

describe("Drive: nome e anteprima", () => {
  it("l'ellissi a metà tiene l'estensione", () => {
    expect(middleEllipsis("Specifiche funzionali dialer v3.pdf")).toEqual({
      head: "Specifiche funzionali dialer v3",
      tail: ".pdf",
    });
    expect(middleEllipsis("README")).toEqual({ head: "README", tail: "" });
    expect(middleEllipsis(".env")).toEqual({ head: ".env", tail: "" });
    expect(middleEllipsis("archivio.tar.gz")).toEqual({ head: "archivio.tar", tail: ".gz" });
  });

  it("quali caricati hanno l'anteprima: immagine, PDF, testo", () => {
    const f = (type: string, mime: string, name = "x") =>
      previewKind({ source: "upload", type, mime, name } as never);
    expect(f("image", "image/png")).toBe("image");
    expect(f("pdf", "application/pdf")).toBe("pdf");
    expect(f("other", "text/plain")).toBe("text");
    expect(f("other", "", "note.md")).toBe("text");
    expect(f("other", "application/zip")).toBeNull();
    expect(f("document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBeNull();
    expect(previewKind({ source: "google", type: "pdf", mime: "application/pdf", name: "x.pdf" } as never)).toBeNull();
  });
});
