import { buildTarget, isAppBuild } from "../data/build";

/** La build «app» servita nel browser (`/app`). */
export function isWebAppBuild(): boolean {
  return isAppBuild() && buildTarget() === "web";
}
