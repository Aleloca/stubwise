import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execa } from "execa";

/**
 * Repo fixture del golden `nightly` (Piano B, Task B11): un mini negozio con
 * quattro moduli documentati, poi CINQUE commit sul branch di default:
 *
 * 1. `cart`     — tocca la pagina «Carrello»;
 * 2. `pricing`  — tocca la pagina «Prezzi»;
 * 3. `noise`    — solo rumore (un documento in `docs/` e il lockfile): riassunto
 *                 deterministico, senza modello;
 * 4. `new-area` — un'area NUOVA (`src/shipping/`) che nessuna pagina copre;
 * 5. `users`    — tocca la pagina «Utenti».
 *
 * La pagina «Magazzino» (`src/inventory/`) non è toccata da nessun commit: deve
 * restare com'è. Due CANARINI servono al controllo dell'allowlist per file
 * (rescan, Disc. 12): uno in un file che i commit cambiano (`src/cart/cart.js`,
 * leggibile), uno in un file che nessun commit tocca (`src/inventory/inventory.js`,
 * NON leggibile: non deve uscire da nessun run, né finire in una pagina).
 *
 * Puro git, niente database né modello: lo usa anche il test del golden.
 */

export type FixtureCommitKind = "cart" | "pricing" | "noise" | "new-area" | "users";

export interface FixtureCommit {
  kind: FixtureCommitKind;
  sha: string;
  subject: string;
}

export interface SeedPage {
  slug: string;
  title: string;
  sourcePath: string;
  body: string;
  /** Un commit della fixture tocca i suoi file. */
  touched: boolean;
}

export interface NightlyFixture {
  /** Repo di lavoro (non bare) con la storia completa. */
  workDir: string;
  /** Upstream bare da cui il mirror fa fetch (`file://`). */
  upstreamUrl: string;
  /** Commit della generazione Docs finta (il segnalibro di partenza). */
  baseSha: string;
  commits: FixtureCommit[];
  headSha: string;
  canaries: {
    listed: { file: string; token: string };
    unlisted: { file: string; token: string };
  };
}

export const NEW_AREA_PREFIX = "src/shipping";

/** Le pagine della generazione finta, al commit base. */
export const SEED_PAGES: SeedPage[] = [
  {
    slug: "carrello",
    title: "Carrello",
    sourcePath: "src/cart",
    touched: true,
    body: [
      "# Carrello",
      "",
      "Il modulo `src/cart/cart.js` tiene le righe del carrello in memoria.",
      "",
      "- `addItem(cart, sku, qty)` aggiunge una riga o ne aumenta la quantità.",
      "- `cartTotal(cart, prices)` somma prezzo × quantità di ogni riga.",
    ].join("\n"),
  },
  {
    slug: "prezzi",
    title: "Prezzi",
    sourcePath: "src/pricing",
    touched: true,
    body: [
      "# Prezzi",
      "",
      "`src/pricing/pricing.js` espone `priceOf(sku)`, che legge il listino fisso.",
      "Non esistono sconti.",
    ].join("\n"),
  },
  {
    slug: "utenti",
    title: "Utenti",
    sourcePath: "src/users",
    touched: true,
    body: [
      "# Utenti",
      "",
      "`src/users/users.js` crea un utente con `createUser(name)`; il nome è l'unico campo.",
    ].join("\n"),
  },
  {
    slug: "magazzino",
    title: "Magazzino",
    sourcePath: "src/inventory",
    touched: false,
    body: [
      "# Magazzino",
      "",
      "`src/inventory/inventory.js` restituisce la giacenza di uno sku con `stockOf(sku)`.",
    ].join("\n"),
  },
];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execa("git", args, {
    cwd,
    env: {
      GIT_AUTHOR_NAME: "Golden Dev",
      GIT_AUTHOR_EMAIL: "golden@example.test",
      GIT_COMMITTER_NAME: "Golden Dev",
      GIT_COMMITTER_EMAIL: "golden@example.test",
    },
  });
  return stdout.trim();
}

async function put(root: string, file: string, content: string): Promise<void> {
  const path = join(root, file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function commitAll(dir: string, subject: string): Promise<string> {
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", subject]);
  return git(dir, ["rev-parse", "HEAD"]);
}

/** Crea la fixture sotto `root` (una dir vuota). */
export async function buildNightlyFixture(root: string): Promise<NightlyFixture> {
  const workDir = join(root, "shop");
  const upstream = join(root, "shop-upstream.git");
  await mkdir(workDir, { recursive: true });
  await git(workDir, ["init", "-q", "-b", "main"]);

  const listedToken = `CANARY-CART-${randomUUID()}`;
  const unlistedToken = `CANARY-INVENTORY-${randomUUID()}`;

  await put(workDir, "package.json", `${JSON.stringify({ name: "shop", version: "1.0.0", type: "module" }, null, 2)}\n`);
  await put(workDir, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  await put(
    workDir,
    "src/cart/cart.js",
    [
      `export const CART_BUILD_ID = "${listedToken}";`,
      "",
      "export function addItem(cart, sku, qty) {",
      "  const line = cart.find((l) => l.sku === sku);",
      "  if (line) line.qty += qty;",
      "  else cart.push({ sku, qty });",
      "  return cart;",
      "}",
      "",
      "export function cartTotal(cart, prices) {",
      "  return cart.reduce((sum, l) => sum + prices[l.sku] * l.qty, 0);",
      "}",
      "",
    ].join("\n"),
  );
  await put(
    workDir,
    "src/pricing/pricing.js",
    ['const LIST = { apple: 100, pear: 120 };', "", "export function priceOf(sku) {", "  return LIST[sku];", "}", ""].join("\n"),
  );
  await put(workDir, "src/users/users.js", ["export function createUser(name) {", "  return { name };", "}", ""].join("\n"));
  await put(
    workDir,
    "src/inventory/inventory.js",
    [
      `export const INVENTORY_BUILD_ID = "${unlistedToken}";`,
      "",
      "const STOCK = { apple: 10, pear: 0 };",
      "",
      "export function stockOf(sku) {",
      "  return STOCK[sku] ?? 0;",
      "}",
      "",
    ].join("\n"),
  );
  const baseSha = await commitAll(workDir, "chore: negozio iniziale");

  const commits: FixtureCommit[] = [];
  const add = async (kind: FixtureCommitKind, subject: string) => {
    commits.push({ kind, subject, sha: await commitAll(workDir, subject) });
  };

  await put(
    workDir,
    "src/cart/cart.js",
    [
      `export const CART_BUILD_ID = "${listedToken}";`,
      "",
      "export function addItem(cart, sku, qty) {",
      "  const line = cart.find((l) => l.sku === sku);",
      "  if (line) line.qty += qty;",
      "  else cart.push({ sku, qty });",
      "  return cart;",
      "}",
      "",
      "/** Toglie del tutto la riga di uno sku dal carrello. */",
      "export function removeItem(cart, sku) {",
      "  return cart.filter((l) => l.sku !== sku);",
      "}",
      "",
      "export function cartTotal(cart, prices) {",
      "  return cart.reduce((sum, l) => sum + prices[l.sku] * l.qty, 0);",
      "}",
      "",
    ].join("\n"),
  );
  await add("cart", "feat(cart): removeItem toglie una riga dal carrello");

  await put(
    workDir,
    "src/pricing/pricing.js",
    [
      'const LIST = { apple: 100, pear: 120 };',
      "",
      "/** Sconto del 10% sopra i 1000 centesimi di subtotale. */",
      "export function discountFor(subtotal) {",
      "  return subtotal > 1000 ? Math.round(subtotal * 0.1) : 0;",
      "}",
      "",
      "export function priceOf(sku) {",
      "  return LIST[sku];",
      "}",
      "",
    ].join("\n"),
  );
  await add("pricing", "feat(pricing): sconto del 10% sopra i 10 euro");

  await put(workDir, "docs/notes.md", "# Note\n\nAppunti di lavoro sul negozio.\n");
  await put(workDir, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n\nimporters: {}\n");
  await add("noise", "docs: appunti e lockfile");

  await put(
    workDir,
    "src/shipping/shipping.js",
    [
      'import { rateFor } from "./rates.js";',
      "",
      "/** Costo di spedizione di un ordine: gratis sopra i 50 euro. */",
      "export function shippingCost(subtotal, zone) {",
      "  return subtotal >= 5000 ? 0 : rateFor(zone);",
      "}",
      "",
    ].join("\n"),
  );
  await put(
    workDir,
    "src/shipping/rates.js",
    ['const RATES = { it: 500, eu: 900 };', "", "export function rateFor(zone) {", "  return RATES[zone] ?? 1500;", "}", ""].join("\n"),
  );
  await add("new-area", "feat(shipping): costo di spedizione per zona");

  await put(
    workDir,
    "src/users/users.js",
    [
      "/** Crea un utente; l'email è obbligatoria e deve contenere una chiocciola. */",
      "export function createUser(name, email) {",
      '  if (!email || !email.includes("@")) throw new Error("email non valida");',
      "  return { name, email };",
      "}",
      "",
    ].join("\n"),
  );
  await add("users", "feat(users): email obbligatoria alla creazione");

  const headSha = await git(workDir, ["rev-parse", "HEAD"]);
  await execa("git", ["clone", "-q", "--bare", workDir, upstream]);

  return {
    workDir,
    upstreamUrl: `file://${upstream}`,
    baseSha,
    commits,
    headSha,
    canaries: {
      listed: { file: "src/cart/cart.js", token: listedToken },
      unlisted: { file: "src/inventory/inventory.js", token: unlistedToken },
    },
  };
}
