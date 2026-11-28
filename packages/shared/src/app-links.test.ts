import { describe, expect, it } from "vitest";
import { APP_ENTRY, appPath, appUrl, legacyWebPath, RESERVED_DOC_PAGE_SLUGS, RESERVED_REPOSITORY_SLUGS, unreservedSlug } from "./app-links.js";

describe("i link della nuova app (app-links)", () => {
  it("una task si apre col parametro `task`, una richiesta col suo id, il progetto sulla panoramica", () => {
    expect(appPath({ to: "task", projectCode: "ACQ", taskCode: "ACQ-12" })).toBe("/#/p/ACQ/tasks?task=ACQ-12");
    expect(appPath({ to: "requests", projectCode: "ACQ", requestId: "7b2c9d1e-4444-4555-8666-777788889999" })).toBe(
      "/#/p/ACQ/requests?request=7b2c9d1e-4444-4555-8666-777788889999",
    );
    expect(appPath({ to: "requests", projectCode: "ACQ" })).toBe("/#/p/ACQ/requests");
    expect(appPath({ to: "project", projectCode: "ACQ" })).toBe("/#/p/ACQ/overview");
    expect(appPath({ to: "project", projectCode: "ACQ", briefId: "b1" })).toBe("/#/p/ACQ/overview?brief=b1");
    expect(appPath({ to: "projectMembers", projectCode: "ACQ" })).toBe("/#/p/ACQ/settings/members");
    expect(appPath({ to: "docs", projectCode: "ACQ", repositorySlug: "web", pageSlug: "checkout" })).toBe("/#/p/ACQ/docs/web/checkout");
    expect(appPath({ to: "server", projectCode: "STW", serverCode: "SRV-2" })).toBe("/#/p/STW/servers/SRV-2");
    expect(appPath({ to: "preferences", section: "security" })).toBe("/#/preferences/security");
    expect(appPath({ to: "preferences", section: "account", search: { google: "ok" } })).toBe("/#/preferences/account?google=ok");
  });

  it("le forme che oggi si scrivono a mano restano IDENTICHE (rilasci, PR, Chat, automazioni, doc di prodotto, Support)", () => {
    const repo = "7b2c9d1e-4444-4555-8666-777788889999";
    expect(appPath({ to: "pullRequest", projectCode: "NEG", repositoryId: repo, prNumber: 88 })).toBe(`/#/p/NEG/releases?pr=${repo}%2388`);
    expect(appPath({ to: "release", projectCode: "NEG", releaseCode: "NEG-V12" })).toBe("/#/p/NEG/releases/NEG-V12");
    expect(appPath({ to: "docs", projectCode: "NEG" })).toBe("/#/p/NEG/docs");
    expect(appPath({ to: "chatMessage", channelId: "c1", messageId: "m1" })).toBe("/#/chat/c1?message=m1");
    expect(appPath({ to: "automation", automationCode: "AUD-A1", runNumber: 2 })).toBe("/#/automations/AUD-A1/runs/2");
    expect(appPath({ to: "automation", automationCode: "AUD-A1", runNumber: null })).toBe("/#/automations/AUD-A1");
    expect(appPath({ to: "productPage", projectCode: "ACQ", pageCode: "ACQ-D5" })).toBe("/#/p/ACQ/docs/product/ACQ-D5");
    expect(appPath({ to: "resetPassword", token: "t" })).toBe("/#/reset-password/t");
    expect(appPath({ to: "emailChange", token: "t" })).toBe("/#/email-change/t");
  });

  it("appUrl: con la radice pubblica (senza doppia barra), senza resta relativo; i valori si codificano", () => {
    expect(appUrl("https://stubwise.example.com/", { to: "home" })).toBe("https://stubwise.example.com/#/home");
    expect(appUrl(null, { to: "home" })).toBe(`${APP_ENTRY}#/home`);
    expect(appPath({ to: "docs", projectCode: "ACQ", repositorySlug: "a b/c" })).toBe("/#/p/ACQ/docs/a%20b%2Fc");
  });

  it("i percorsi del web vecchio che restano finché esiste", () => {
    expect(legacyWebPath.ticket("t1")).toBe("/tickets/t1");
    expect(legacyWebPath.backlogItem("b1")).toBe("/backlog/b1");
    expect(legacyWebPath.googleAccountSettings("ok")).toBe("/settings/account?google=ok");
  });
});

describe("revisione dei link: codici vuoti e slug riservati", () => {
  it("M3: un codice di progetto vuoto porta alla Home, mai a /p//…", () => {
    expect(appPath({ to: "docs", projectCode: "" })).toBe("/#/home");
    expect(appPath({ to: "release", projectCode: "", releaseCode: "X-V1" })).toBe("/#/home");
    expect(appPath({ to: "pullRequest", projectCode: "", repositoryId: "r", prNumber: 1 })).toBe("/#/home");
  });

  it("M4: gli slug che l'indirizzo dei Docs usa già prendono un suffisso, gli altri restano", () => {
    expect(unreservedSlug("product", RESERVED_REPOSITORY_SLUGS, "repo")).toBe("product-repo");
    for (const slug of ["new", "brief", "releases", "graph"]) expect(unreservedSlug(slug, RESERVED_DOC_PAGE_SLUGS, "page")).toBe(`${slug}-page`);
    expect(unreservedSlug("checkout", RESERVED_DOC_PAGE_SLUGS, "page")).toBe("checkout");
    expect(unreservedSlug("products", RESERVED_REPOSITORY_SLUGS, "repo")).toBe("products");
  });
});
