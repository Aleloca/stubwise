import { personDayActivitySchema, personViewSchema } from "@stubwise/shared";
import type { PersonDayActivityView, PersonView, Reader } from "@stubwise/shared";
import { z } from "zod";
import type { ApiRequest } from "../client.js";
import { toQuery } from "../query.js";

/** Le persone che chi chiama vede (chi condivide un progetto, più sé stesso). */
export function createPeopleEndpoints(request: ApiRequest) {
  return {
    list(): Promise<Reader<PersonView>[]> {
      return request("GET", "/api/people", undefined, z.array(personViewSchema));
    },
    /**
     * L'attività del giorno per persona (area 3, fetta 3d: lo standup), con
     * `people.activity.view`. `date` è `YYYY-MM-DD` nel fuso Europe/Rome.
     */
    activity(date: string, departmentId?: string): Promise<Reader<PersonDayActivityView>[]> {
      return request("GET", `/api/people/activity${toQuery({ date, departmentId })}`, undefined, z.array(personDayActivitySchema));
    },
  };
}
