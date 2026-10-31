import { forgetSecret, storeProvidedSecret } from "../admin/secrets";
import { recordChange } from "../changelog/index";
import type { EnvFile, ProjectEnvironment } from "../model";
import { gate, newId, now, state } from "../store";
import { notFound, forbidden, writer } from "../writer";
import { canI, reauthRefusal, refuse } from "./common";
import { openProject } from "./reads";
import { MANAGE_REPOS, managedRepository } from "./repositories";
import type { ProjectRefusal, ProjectResult } from "./types";

// I file d'ambiente dei repository (area 9c, Task 4), nella pagina del
// repository. Si leggono e si scrivono SOLO con `repos.manage`, come sul
// web: senza, la lettura lancia `forbidden` e le scritture lo rispondono.
// - Il valore di una variabile va nel caveau
//   (`storeProvidedSecret("env_value", fileId, value)`) e non esce più:
//   nessuna lettura lo restituisce, nemmeno le ultime 4 cifre. Di una
//   variabile si vede il nome e quando è stata scritta.
// - Solo l'ambiente `test` arriva a Claude (`reachesClaude`, invariante del
//   `CLAUDE.md`): gli altri si conservano per essere sostituiti.
// - Importare, impostare, rimuovere una variabile ed eliminare un file
//   chiedono la riconferma (+R); creare un file vuoto no.
// - Le voci dicono il nome della variabile (`params.key`), mai il valore;
//   `env_file.imported` dice quante (`params.count`). L'oggetto è il file,
//   col percorso come etichetta (un nome dato da una persona).

/** Il nome di una variabile, come sul web. */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const KIND_ORDER: readonly ProjectEnvironment["kind"][] = ["test", "staging", "production"];

export interface EnvFileView {
  id: string;
  path: string;
  keys: { key: string; setAt: string }[];
}

const fileObject = (f: EnvFile) => ({ type: "env_file", id: f.id, label: f.path });

/** Campo per campo: niente id del caveau. */
const fileView = (f: EnvFile): EnvFileView => ({
  id: f.id,
  path: f.path,
  keys: f.vars.map((v) => ({ key: v.key, setAt: v.setAt })),
});

/**
 * I file d'ambiente di un repository, un gruppo per ambiente del progetto
 * (test, staging, production). `not_found` se il repository non c'è per chi
 * guarda (R-G5), `forbidden` senza `repos.manage`.
 */
export async function listEnvFiles(repositoryId: string): Promise<{
  environments: {
    id: string;
    name: string;
    kind: "test" | "staging" | "production";
    reachesClaude: boolean;
    files: EnvFileView[];
  }[];
}> {
  const me = await gate("projectSettings.listEnvFiles");
  const repository = state.repositories.find((r) => r.id === repositoryId);
  const project = repository ? openProject(me, repository.projectId) : null;
  if (!repository || !project) throw notFound();
  if (!canI(me, MANAGE_REPOS, project.id)) throw forbidden();
  return {
    environments: state.environments
      .filter((e) => e.projectId === project.id)
      .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
      .map((e) => ({
        id: e.id,
        name: e.name,
        kind: e.kind,
        reachesClaude: e.kind === "test",
        files: state.envFiles
          .filter((f) => f.repositoryId === repositoryId && f.environmentId === e.id)
          .map(fileView),
      })),
  };
}

/** Il file su cui scrivere: il suo repository con `repos.manage` (o `not_found`/`forbidden`). */
function managedFile(
  me: string,
  fileId: string,
): { file: EnvFile; projectId: string } | { refusal: ProjectRefusal } {
  const file = state.envFiles.find((f) => f.id === fileId);
  if (!file) return { refusal: refuse.notFound() };
  const managed = managedRepository(me, file.repositoryId);
  if ("refusal" in managed) return managed;
  return { file, projectId: managed.project.id };
}

/** Un percorso relativo alla radice del repository, senza `..` né `/` iniziale. */
const validPath = (path: string): boolean =>
  path !== "" &&
  !path.startsWith("/") &&
  !path.includes("\\") &&
  !/\s/.test(path) &&
  !path.split("/").some((seg) => seg === ".." || seg === "");

/** Crea un file vuoto in un ambiente del progetto del repository (nessuna riconferma). */
export async function createEnvFile(
  repositoryId: string,
  input: { environmentId: string; path: string },
): Promise<ProjectResult<{ fileId: string }>> {
  const me = await writer("projectSettings.createEnvFile");
  const managed = managedRepository(me, repositoryId);
  if ("refusal" in managed) return managed.refusal;
  const { project } = managed;
  const environment = state.environments.find(
    (e) => e.id === input.environmentId && e.projectId === project.id,
  );
  if (!environment) return refuse.invalid("environment");
  const path = input.path.trim();
  if (!validPath(path)) return refuse.invalid("path");
  if (
    state.envFiles.some(
      (f) =>
        f.repositoryId === repositoryId && f.environmentId === environment.id && f.path === path,
    )
  )
    return refuse.invalid("path_taken");

  const file: EnvFile = {
    id: newId("envf"),
    repositoryId,
    environmentId: environment.id,
    path,
    vars: [],
  };
  state.envFiles.push(file);
  recordChange({
    kind: "env_file.created",
    actorId: me,
    projectId: project.id,
    object: fileObject(file),
  });
  return { ok: true, fileId: file.id };
}

/** Scrive (o sostituisce) una variabile: il valore nel caveau, quello di prima dimenticato. */
function putVar(file: EnvFile, key: string, value: string): "imported" | "replaced" {
  const secret = storeProvidedSecret("env_value", file.id, value);
  const at = now();
  const existing = file.vars.find((v) => v.key === key);
  if (existing) {
    if (existing.secretId) forgetSecret(existing.secretId);
    existing.secretId = secret.id;
    existing.setAt = at;
    return "replaced";
  }
  file.vars.push({ key, secretId: secret.id, setAt: at });
  return "imported";
}

type Skipped = { line: number; reason: "syntax" | "key" };

/**
 * Le righe di un `.env`: `KEY=value`, `export KEY=value`, valori fra
 * virgolette (doppie o semplici, tolte); commenti `#` e righe vuote si
 * ignorano. Ogni altra riga è saltata col suo numero, mai col contenuto.
 * Una chiave ripetuta vale per l'ultima riga.
 */
function parseEnv(content: string): { vars: Map<string, string>; skipped: Skipped[] } {
  const vars = new Map<string, string>();
  const skipped: Skipped[] = [];
  content.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const body = line.replace(/^export\s+/, "");
    const eq = body.indexOf("=");
    if (eq <= 0) {
      skipped.push({ line: i + 1, reason: "syntax" });
      return;
    }
    const key = body.slice(0, eq).trim();
    if (!KEY_RE.test(key)) {
      skipped.push({ line: i + 1, reason: /\s/.test(key) ? "syntax" : "key" });
      return;
    }
    let value = body.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote))
      value = value.slice(1, -1);
    vars.delete(key);
    vars.set(key, value);
  });
  return { vars, skipped };
}

/**
 * Importa un testo `.env` nel file (+R). Niente di valido → `invalid:
 * "nothing_to_import"`, senza chiedere la riconferma. Un nome già nel file
 * è sostituito.
 */
export async function importEnvFile(
  fileId: string,
  content: string,
): Promise<
  ProjectResult<{
    imported: string[];
    replaced: string[];
    skipped: Skipped[];
  }>
> {
  const me = await writer("projectSettings.importEnvFile");
  const managed = managedFile(me, fileId);
  if ("refusal" in managed) return managed.refusal;
  const { vars, skipped } = parseEnv(typeof content === "string" ? content : "");
  if (vars.size === 0) return refuse.invalid("nothing_to_import");
  const blocked = reauthRefusal(me, "projectSettings.importEnvFile");
  if (blocked) return blocked;

  const { file, projectId } = managed;
  const imported: string[] = [];
  const replaced: string[] = [];
  for (const [key, value] of vars)
    (putVar(file, key, value) === "replaced" ? replaced : imported).push(key);
  recordChange({
    kind: "env_file.imported",
    actorId: me,
    projectId,
    object: fileObject(file),
    params: { count: String(vars.size) },
  });
  return { ok: true, imported, replaced, skipped };
}

/** Imposta una variabile (+R): aggiunge o sostituisce. Il valore non esce più. */
export async function setEnvVar(
  fileId: string,
  key: string,
  value: string,
): Promise<ProjectResult> {
  const me = await writer("projectSettings.setEnvVar");
  const managed = managedFile(me, fileId);
  if ("refusal" in managed) return managed.refusal;
  if (typeof key !== "string" || !KEY_RE.test(key)) return refuse.invalid("key");
  if (typeof value !== "string") return refuse.invalid("value");
  const blocked = reauthRefusal(me, "projectSettings.setEnvVar");
  if (blocked) return blocked;

  const { file, projectId } = managed;
  putVar(file, key, value);
  recordChange({
    kind: "env_var.set",
    actorId: me,
    projectId,
    object: fileObject(file),
    params: { key },
  });
  return { ok: true };
}

/** Rimuove una variabile (+R); il valore esce dal caveau. Una che non c'è è `not_found`. */
export async function removeEnvVar(fileId: string, key: string): Promise<ProjectResult> {
  const me = await writer("projectSettings.removeEnvVar");
  const managed = managedFile(me, fileId);
  if ("refusal" in managed) return managed.refusal;
  const { file, projectId } = managed;
  const existing = file.vars.find((v) => v.key === key);
  if (!existing) return refuse.notFound();
  const blocked = reauthRefusal(me, "projectSettings.removeEnvVar");
  if (blocked) return blocked;

  if (existing.secretId) forgetSecret(existing.secretId);
  file.vars = file.vars.filter((v) => v !== existing);
  recordChange({
    kind: "env_var.removed",
    actorId: me,
    projectId,
    object: fileObject(file),
    params: { key },
  });
  return { ok: true };
}

/** Elimina un file e le sue variabili (+R); i valori escono dal caveau. */
export async function deleteEnvFile(fileId: string): Promise<ProjectResult> {
  const me = await writer("projectSettings.deleteEnvFile");
  const managed = managedFile(me, fileId);
  if ("refusal" in managed) return managed.refusal;
  const blocked = reauthRefusal(me, "projectSettings.deleteEnvFile");
  if (blocked) return blocked;

  const { file, projectId } = managed;
  for (const v of file.vars) if (v.secretId) forgetSecret(v.secretId);
  state.envFiles = state.envFiles.filter((f) => f !== file);
  recordChange({
    kind: "env_file.deleted",
    actorId: me,
    projectId,
    object: fileObject(file),
  });
  return { ok: true };
}
