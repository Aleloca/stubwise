import { personViewSchema } from "@stubwise/shared";
import type { PersonView, Reader } from "@stubwise/shared";
import { z } from "zod";
import type { ApiRequest } from "../client.js";

/** Le persone che chi chiama vede (chi condivide un progetto, più sé stesso). */
export function createPeopleEndpoints(request: ApiRequest) {
  return {
    list(): Promise<Reader<PersonView>[]> {
      return request("GET", "/api/people", undefined, z.array(personViewSchema));
    },
  };
}
