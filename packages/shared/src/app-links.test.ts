import { describe, expect, it } from "vitest";
import { APP_ENTRY, appPath, appUrl, vaultPagePath, vaultPageUrl, legacyWebPath, RESERVED_DOC_PAGE_SLUGS, RESERVED_REPOSITORY_SLUGS, unreservedSlug } from "./app-links.js";

describe("i link della nuova app (app-links)", () => {
  it("una task si apre col parametro `task`, una richiesta col suo id, il progetto sulla panoramica", () => {
    expect(appPath({ to: "task", projectCode: "ACQ", taskCode: "ACQ-12" })).toBe("/app/#/p/ACQ/tasks?task=ACQ-12");
    expect(appPath({ to: "requests", projectCode: "ACQ", requestId: "7b2c9d1e-4444-4555-8666-777788889999" })).toBe(
      "/app/#/p/ACQ/requests?request=7b2c9d1e-4444-4555-8666-777788889999",
    );
    expect(appPath({ to: "requests", projectCode: "ACQ" })).toBe("/app/#/p/ACQ/requests");
    expect(appPath({ to: "project", projectCode: "ACQ" })).toBe("/app/#/p/ACQ/overview");
    expect(appPath({ to: "project", projectCode: "ACQ", briefId: "b1" })).toBe("/app/#/p/ACQ/overview?brief=b1");
    expect(appPath({ to: "projectMembers", projectCode: "ACQ" })).toBe("/app/#/p/ACQ/settings/members");
    expect(appPath({ to: "docs", projectCode: "ACQ", repositorySlug: "web", pageSlug: "checkout" })).toBe("/app/#/p/ACQ/docs/web/checkout");
    expect(appPath({ to: "server", projectCode: "STW", serverCode: "SRV-2" })).toBe("/app/#/p/STW/servers/SRV-2");
    expect(appPath({ to: "preferences", section: "security" })).toBe("/app/#/preferences/security");
    expect(appPath({ to: "preferences", section: "account", search: { google: "ok" } })).toBe("/app/#/preferences/account?google=ok");
  });

  it("le forme che oggi si scrivono a mano restano IDENTICHE (rilasci, PR, Chat, automazioni, doc di prodotto, Support)", () => {
    const repo = "7b2c9d1e-4444-4555-8666-777788889999";
    expect(appPath({ to: "pullRequest", projectCode: "NEG", repositoryId: repo, prNumber: 88 })).toBe(`/app/#/p/NEG/releases?pr=${repo}%2388`);
    expect(appPath({ to: "release", projectCode: "NEG", releaseCode: "NEG-V12" })).toBe("/app/#/p/NEG/releases/NEG-V12");
    expect(appPath({ to: "docs", projectCode: "NEG" })).toBe("/app/#/p/NEG/docs");
    expect(appPath({ to: "chatMessage", channelId: "c1", messageId: "m1" })).toBe("/app/#/chat/c1?message=m1");
    expect(appPath({ to: "automation", automationCode: "AUD-A1", runNumber: 2 })).toBe("/app/#/automations/AUD-A1/runs/2");
    expect(appPath({ to: "automation", automationCode: "AUD-A1", runNumber: null })).toBe("/app/#/automations/AUD-A1");
    expect(appPath({ to: "productPage", projectCode: "ACQ", pageCode: "ACQ-D5" })).toBe("/app/#/p/ACQ/docs/product/ACQ-D5");
    expect(appPath({ to: "resetPassword", token: "t" })).toBe("/app/#/reset-password/t");
    expect(appPath({ to: "emailChange", token: "t" })).toBe("/app/#/email-change/t");
  });

  it("appUrl: con la radice pubblica (senza doppia barra), senza resta relativo; i valori si codificano", () => {
    expect(appUrl("https://stubwise.example.com/", { to: "home" })).toBe("https://stubwise.example.com/app/#/home");
    expect(appUrl(null, { to: "home" })).toBe(`${APP_ENTRY}#/home`);
    expect(appPath({ to: "docs", projectCode: "ACQ", repositorySlug: "a b/c" })).toBe("/app/#/p/ACQ/docs/a%20b%2Fc");
  });

  it("i percorsi del web vecchio che restano finché esiste", () => {
    expect(legacyWebPath.ticket("t1")).toBe("/tickets/t1");
    expect(legacyWebPath.backlogItem("b1")).toBe("/backlog/b1");
    expect(legacyWebPath.googleAccountSettings("ok")).toBe("/settings/account?google=ok");
  });
});

describe("revisione dei link: codici vuoti e slug riservati", () => {
  it("la cassaforte: la pagina, la configurazione e l'associazione del Mac (fase 2)", () => {
    expect(appPath({ to: "vault" })).toBe("/app/#/vault");
  });

  it("I-2: la pagina a sé della cassaforte sta sotto l'ingresso dell'app (`/app/vault/`), e ci si entra coi suoi frammenti", () => {
    expect(vaultPagePath("setup")).toBe(`${APP_ENTRY}vault/#/setup`);
    expect(appPath({ to: "login", search: { next: "vault-pair", state: "s" } })).toBe("/app/#/login?next=vault-pair&state=s");
    expect(vaultPagePath("recover")).toBe("/app/vault/#/recover");
    expect(vaultPagePath("passkeys")).toBe("/app/vault/#/passkeys");
    expect(vaultPagePath("pair", { state: "c3Rh-dGU_" })).toBe("/app/vault/#/pair?state=c3Rh-dGU_");
    expect(vaultPageUrl("https://stubwise.example/", "pair", { state: "a b" })).toBe(
      "https://stubwise.example/app/vault/#/pair?state=a+b",
    );
  });

  it("M3: un codice di progetto vuoto porta alla Home, mai a /p//…", () => {
    expect(appPath({ to: "docs", projectCode: "" })).toBe("/app/#/home");
    expect(appPath({ to: "release", projectCode: "", releaseCode: "X-V1" })).toBe("/app/#/home");
    expect(appPath({ to: "pullRequest", projectCode: "", repositoryId: "r", prNumber: 1 })).toBe("/app/#/home");
  });

  it("M4: gli slug che l'indirizzo dei Docs usa già prendono un suffisso, gli altri restano", () => {
    expect(unreservedSlug("product", RESERVED_REPOSITORY_SLUGS, "repo")).toBe("product-repo");
    for (const slug of ["new", "brief", "releases", "graph"]) expect(unreservedSlug(slug, RESERVED_DOC_PAGE_SLUGS, "page")).toBe(`${slug}-page`);
    expect(unreservedSlug("checkout", RESERVED_DOC_PAGE_SLUGS, "page")).toBe("checkout");
    expect(unreservedSlug("products", RESERVED_REPOSITORY_SLUGS, "repo")).toBe("products");
  });
});
