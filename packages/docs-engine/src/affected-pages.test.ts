import { describe, expect, it } from "vitest";
import { mapAffectedPages, type PageRef } from "./affected-pages.js";

/** Helper per costruire una PageRef con default sensati. */
function page(over: Partial<PageRef> & { id: string }): PageRef {
  return {
    slug: over.id,
    title: over.id,
    sourcePath: null,
    parentId: null,
    ...over,
  };
}

const HIGH_CAP = 100;

describe("mapAffectedPages", () => {
  it("covers a file by an exact sourcePath match", () => {
    const pages = [page({ id: "p", sourcePath: "src/auth/login.ts" })];
    const res = mapAffectedPages(["src/auth/login.ts"], pages, HIGH_CAP);
    expect(res.affected.map((p) => p.id)).toEqual(["p"]);
    expect(res.newAreas).toEqual([]);
    expect(res.truncated).toBe(0);
  });

  it("covers a file by an ANCESTOR directory sourcePath", () => {
    const pages = [page({ id: "auth", sourcePath: "src/auth" })];
    const res = mapAffectedPages(["src/auth/login.ts"], pages, HIGH_CAP);
    expect(res.affected.map((p) => p.id)).toEqual(["auth"]);
    expect(res.newAreas).toEqual([]);
  });

  it("picks the MOST SPECIFIC page (longest sourcePath) when several cover the file", () => {
    const pages = [
      page({ id: "src", sourcePath: "src" }),
      page({ id: "auth", sourcePath: "src/auth" }),
      page({ id: "login", sourcePath: "src/auth/login.ts" }),
    ];
    const res = mapAffectedPages(["src/auth/login.ts"], pages, HIGH_CAP);
    // La più specifica vince; gli altri non sono né primari né genitori (parentId null).
    expect(res.affected.map((p) => p.id)).toEqual(["login"]);
  });

  it("includes the PARENT page (via parentId) of the impacted page", () => {
    const pages = [
      page({ id: "overview", slug: "overview", sourcePath: null }),
      page({
        id: "login",
        slug: "login",
        sourcePath: "src/auth/login.ts",
        parentId: "overview",
      }),
    ];
    const res = mapAffectedPages(["src/auth/login.ts"], pages, HIGH_CAP);
    expect(res.affected.map((p) => p.id).sort()).toEqual(["login", "overview"]);
  });

  it("includes a parent that itself has a sourcePath (one level only)", () => {
    const pages = [
      page({ id: "root", slug: "root", sourcePath: "src", parentId: null }),
      page({
        id: "auth",
        slug: "auth",
        sourcePath: "src/auth",
        parentId: "root",
      }),
    ];
    const res = mapAffectedPages(["src/auth/login.ts"], pages, HIGH_CAP);
    // auth è la primaria; root è incluso come genitore (un solo livello).
    expect(res.affected.map((p) => p.id).sort()).toEqual(["auth", "root"]);
    // auth ha priorità (depth maggiore) → primo.
    expect(res.affected[0]?.id).toBe("auth");
  });

  it("puts an uncovered file into newAreas", () => {
    const pages = [page({ id: "auth", sourcePath: "src/auth" })];
    const res = mapAffectedPages(["src/billing/invoice.ts"], pages, HIGH_CAP);
    expect(res.affected).toEqual([]);
    expect(res.newAreas).toEqual(["src/billing/invoice.ts"]);
  });

  it("ignores pages with a null sourcePath when covering files", () => {
    const pages = [page({ id: "overview", sourcePath: null })];
    const res = mapAffectedPages(["src/auth/login.ts"], pages, HIGH_CAP);
    expect(res.affected).toEqual([]);
    expect(res.newAreas).toEqual(["src/auth/login.ts"]);
  });

  it("matches by SEGMENT: 'src/au' does NOT cover 'src/auth/x.ts'", () => {
    const pages = [page({ id: "au", sourcePath: "src/au" })];
    const res = mapAffectedPages(["src/auth/x.ts"], pages, HIGH_CAP);
    expect(res.affected).toEqual([]);
    expect(res.newAreas).toEqual(["src/auth/x.ts"]);
  });

  it("normalizes leading slashes on changed files", () => {
    const pages = [page({ id: "auth", sourcePath: "src/auth" })];
    const res = mapAffectedPages(["/src/auth/login.ts"], pages, HIGH_CAP);
    expect(res.affected.map((p) => p.id)).toEqual(["auth"]);
  });

  it("dedups affected pages across multiple files hitting the same page", () => {
    const pages = [page({ id: "auth", sourcePath: "src/auth" })];
    const res = mapAffectedPages(
      ["src/auth/a.ts", "src/auth/b.ts", "src/auth/c.ts"],
      pages,
      HIGH_CAP,
    );
    expect(res.affected.map((p) => p.id)).toEqual(["auth"]);
  });

  it("dedups and stably orders newAreas", () => {
    const res = mapAffectedPages(
      ["z/b.ts", "a/c.ts", "z/b.ts", "a/c.ts"],
      [],
      HIGH_CAP,
    );
    expect(res.newAreas).toEqual(["a/c.ts", "z/b.ts"]);
  });

  it("applies the cap, keeping the deepest matches and counting truncated", () => {
    const pages = [
      page({ id: "shallow", slug: "shallow", sourcePath: "src" }),
      page({ id: "mid", slug: "mid", sourcePath: "src/auth" }),
      page({ id: "deep", slug: "deep", sourcePath: "src/auth/login.ts" }),
    ];
    // Tre file, ciascuno colpisce la sua pagina più specifica indipendente.
    const res = mapAffectedPages(
      ["src/x.ts", "src/auth/y.ts", "src/auth/login.ts"],
      pages,
      2,
    );
    // Le due più profonde vincono: deep (3 segmenti) e mid (2 segmenti).
    expect(res.affected.map((p) => p.id)).toEqual(["deep", "mid"]);
    expect(res.truncated).toBe(1);
  });

  it("maxPages = 0 disables regeneration but still reports newAreas", () => {
    const pages = [page({ id: "auth", sourcePath: "src/auth" })];
    const res = mapAffectedPages(
      ["src/auth/a.ts", "src/billing/b.ts"],
      pages,
      0,
    );
    expect(res.affected).toEqual([]);
    expect(res.truncated).toBe(0);
    expect(res.newAreas).toEqual(["src/billing/b.ts"]);
  });

  it("counts truncation including parent-overview pages over the cap", () => {
    const pages = [
      page({ id: "overview", slug: "overview", sourcePath: null }),
      page({
        id: "a",
        slug: "a",
        sourcePath: "src/a",
        parentId: "overview",
      }),
      page({
        id: "b",
        slug: "b",
        sourcePath: "src/b",
        parentId: "overview",
      }),
    ];
    // Due primarie (depth 1) + un genitore overview (depth 0) = 3 affette; cap a 2.
    const res = mapAffectedPages(["src/a/x.ts", "src/b/y.ts"], pages, 2);
    // Le due primarie (depth 1) battono il genitore overview (depth 0).
    expect(res.affected.map((p) => p.id)).toEqual(["a", "b"]);
    expect(res.truncated).toBe(1);
  });
});
