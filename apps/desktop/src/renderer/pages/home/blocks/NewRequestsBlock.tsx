import { useState } from "react";
import { useTranslation } from "react-i18next";
import { usePeople, useProjects, useRequestsToConvert } from "../../../data/queries";
import { useToast } from "../../../tasks-ui/Toast";
import { NewTaskDialog } from "../../task/NewTaskDialog";
import { BlockSection, Capped, queryState, useOpenTask } from "./BlockSection";
import { RequestItem } from "./DecideBlock";

/**
 * «New requests»: le richieste arrivate nei progetti dove posso creare task
 * e non ancora trasformate (nuove, in rifinitura, pronte), dalla più
 * recente. «Turn into task» apre la nuova task precompilata dalla richiesta.
 * Il blocco è nel catalogo solo di chi ha `tickets.create` da qualche parte.
 */
export function NewRequestsBlock() {
  const { t } = useTranslation();
  const toast = useToast();
  const openTask = useOpenTask();
  const requests = useRequestsToConvert();
  const projects = useProjects();
  const people = usePeople();
  const [converting, setConverting] = useState<string | null>(null);
  const list = requests.data ?? [];
  const state = queryState([requests, projects], {
    when: list.length === 0,
    text: t("home.requests.empty"),
  });
  return (
    <BlockSection title={t("home.blocks.newRequests")} count={list.length} state={state}>
      <Capped
        items={list}
        render={(r) => (
          <li key={r.id}>
            <RequestItem
              labelled={false}
              request={r}
              project={projects.data?.find((p) => p.id === r.projectId)}
              requester={people.data?.find((p) => p.id === r.requesterIds[0])}
              onConvert={() => setConverting(r.id)}
            />
          </li>
        )}
      />
      {converting && (
        <NewTaskDialog
          fromRequestId={converting}
          onClose={() => setConverting(null)}
          onCreated={(task) => {
            setConverting(null);
            toast.show(t("home.decide.created", { code: task.code }));
            openTask(task.code);
          }}
        />
      )}
    </BlockSection>
  );
}
