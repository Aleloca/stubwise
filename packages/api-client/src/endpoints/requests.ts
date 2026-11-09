import { requestToConvertViewSchema } from "@stubwise/shared";
import type { Reader, RequestToConvertView } from "@stubwise/shared";
import { z } from "zod";
import type { ApiRequest } from "../client.js";

/**
 * Le richieste dell'app nuova (integrazione area 2, fetta 3). Per ora solo
 * quelle da trasformare in task, per «Da decidere» e il blocco «Richieste
 * nuove»: la sezione Requests arriva con la fetta 4.
 */
export function createRequestsEndpoints(request: ApiRequest) {
  return {
    /** Nuove, in rifinitura o pronte, non fuse, dei progetti dove posso creare task; dalla più recente. */
    toConvert(): Promise<Reader<RequestToConvertView>[]> {
      return request("GET", "/api/requests/to-convert", undefined, z.array(requestToConvertViewSchema));
    },
  };
}
