import { useQuery } from "@tanstack/react-query";
import * as api from "../api";
import { useSessionPersonId } from "../queries";

// Gli hook dell'istanza (area 9b); `data/queries` li ri-esporta. L'import
// circolare con `../queries` è innocuo: gli helper si usano solo dentro le
// funzioni. I Task 3–7 ci aggiungono i loro.

export type { UsageDimension, UsageRange, UsageRow, UsageView } from "../instance/usage";

/** I consumi della scheda Usage (errore `forbidden` senza `usage.view`). */
export function useUsage(input: {
  range: api.instance.UsageRange;
  groupBy: api.instance.UsageDimension;
  thenBy?: api.instance.UsageDimension;
}) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: ["as", me, "instance", "usage", input] as const,
    queryFn: () => api.instance.getUsage(input),
  });
}
