import type { InboxItem, Reader } from "@stubwise/shared";
import { FailedCard } from "./FailedCard";
import { InfoCard } from "./InfoCard";
import { PlanReviewCard } from "./PlanReviewCard";
import { PrReadyCard } from "./PrReadyCard";
import { PulseProposalCard } from "./PulseProposalCard";
import { QuestionCard } from "./QuestionCard";
import { hasDecisionAction } from "../../lib/inbox-sections";

export interface InboxCardProps {
  item: Reader<InboxItem>;
  /** Nome del progetto, risolto dallo screen (che ha già la lista progetti) — assente se non risolvibile. */
  projectName?: string;
}

/**
 * Sceglie una delle sei varianti in base al `kind` — e ricade su `InfoCard`
 * per ogni kind senza layout bespoke, incluso il segnaposto `UNKNOWN` di un
 * kind che questa build dell'app non conosce ancora (vedi `Reader<T>` in
 * `@stubwise/shared`): un'app più vecchia del server non deve mai piantare su
 * una notifica nuova, deve solo mostrarla in modo più generico.
 *
 * Le varianti "a domanda" (`QuestionCard`, `PulseProposalCard`) ricadono
 * anch'esse su `InfoCard` quando il payload strutturato (`question`/`pulse`)
 * non c'è: sono OPZIONALI nel contratto apposta per questo caso — una riga
 * scritta da una versione precedente del server, o un payload che il
 * recinto server non ha saputo rileggere.
 *
 * `job.plan_review` ricade su `InfoCard` quando `actions` NON contiene
 * `approve_plan`/`reject_plan` — cioè la copia di chi ha CHIESTO il piano,
 * non di chi lo deve approvare: `InfoCard` la degrada a pura informazione
 * ("Aspetta un maintainer.", canvas `1b` — sezione "In attesa di altri").
 * `PlanReviewCard` resta riservata a chi la decisione la può prendere
 * davvero.
 */
export function InboxCard({ item, projectName }: InboxCardProps) {
  switch (item.kind) {
    case "job.awaiting_input":
      return item.question !== undefined ? (
        <QuestionCard item={item} projectName={projectName} />
      ) : (
        <InfoCard item={item} projectName={projectName} />
      );
    case "project.pulse":
      return item.question !== undefined && item.pulse !== undefined ? (
        <PulseProposalCard item={item} projectName={projectName} />
      ) : (
        <InfoCard item={item} projectName={projectName} />
      );
    case "job.plan_review":
      return hasDecisionAction(item) ? (
        <PlanReviewCard item={item} projectName={projectName} />
      ) : (
        <InfoCard item={item} projectName={projectName} />
      );
    case "job.pr_opened":
    case "review.completed":
      return <PrReadyCard item={item} projectName={projectName} />;
    case "job.failed":
      return <FailedCard item={item} projectName={projectName} />;
    default:
      return <InfoCard item={item} projectName={projectName} />;
  }
}
