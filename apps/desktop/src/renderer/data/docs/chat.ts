// `readsAs` si usa solo dentro la funzione: l'import circolare
// (api-mutations → … → docs) è innocuo, come per @Claude nella Chat.
import {
  driveRef,
  fileQuestion,
  filesFoundText,
  findInFiles,
} from "../../domain/claude/intents/files";
import { docsAnswer } from "../../domain/claude/intents/howto";
import type { T } from "../../domain/claude/intents";
import i18n from "../../i18n";
import { readsAs } from "../api-mutations";
import { gate, now, state } from "../store";
import type { DocsAnswer, DocsQuestion } from "../types";
import { docsAccess, docSpaceOf, repositoryById } from "./reads";

// La chat dei Docs (area 5): del progetto (tutti i suoi repository) o di un
// repository solo. Il prototipo non chiama un modello: la risposta viene dal
// motore di intenti (`docsAnswer`), che legge come chi chiede — le pagine
// che lui legge, e basta — e cita le pagine per codice. Serve un provider
// con chiave API (`state.docsChatProvider`): senza, `chat_unavailable`.

const notFound = () => new Error("not_found");

/** Una domanda alla chat dei Docs: la risposta in Markdown con le pagine citate. */
export async function askDocs({
  projectId,
  repositoryId,
  question,
}: DocsQuestion): Promise<DocsAnswer> {
  const me = await gate("docs.askDocs");
  const access = docsAccess(me, projectId);
  if (access === "none") throw notFound();
  if (access === "forbidden") throw new Error("forbidden");
  if (repositoryId !== undefined && docSpaceOf(repositoryId)?.projectId !== projectId) {
    throw notFound();
  }
  if (state.docsChatProvider === null) throw new Error("chat_unavailable");
  const project = state.projectsById.get(projectId)!;
  const pages = (await readsAs(me).listDocPages(projectId)).filter(
    (p) => repositoryId === undefined || p.repositoryId === repositoryId,
  );
  const repoName = (id: string) => repositoryById(id)?.name ?? "";
  const t = i18n.t.bind(i18n) as T;
  const answer = docsAnswer(question, pages, t, {
    scope: repositoryId ? repoName(repositoryId) : project.code,
    repoName,
  });
  const sources = answer.pages.map((p) => ({
    pageId: p.id,
    repositoryName: repoName(p.repositoryId),
  }));
  // Le fonti possono essere anche i file del Drive del progetto (shape
  // drive-search.md): letti come chi chiede, senza contare aperture. Se un
  // file risponde, la risposta parte da lui e le pagine trovate seguono;
  // senza file, la risposta dei soli Docs come prima. I file vengono DOPO le
  // pagine in `refs`, così `sources[i]` resta la fonte del ref i-esimo.
  const q = fileQuestion(question);
  const found = q
    ? findInFiles(
        q,
        (await readsAs(me).readDriveFiles()).filter((f) => f.projectId === projectId),
      )
    : null;
  if (found) {
    const fileText = filesFoundText(t, found, project.code);
    return {
      answeredAt: now(),
      text: answer.pages.length > 0 ? `${fileText}\n\n${answer.text}` : fileText,
      refs: [...answer.refs, driveRef(found.file)],
      sources,
    };
  }
  return { answeredAt: now(), text: answer.text, refs: answer.refs, sources };
}
