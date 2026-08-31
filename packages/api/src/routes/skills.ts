import type { StorageService } from "../services/storage.ts";
import { createArtifactRoutes } from "./artifacts.ts";

// ⟦𓂩𓈑𓄿𓇋⟧ createSkillRoutes :: auto-generated pointer for public function createSkillRoutes
export function createSkillRoutes(storage: StorageService) {
  return createArtifactRoutes(storage, "skills");
}
