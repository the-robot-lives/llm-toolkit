import type { StorageService } from "../services/storage.ts";
import { createArtifactRoutes } from "./artifacts.ts";

// <REMOVED UUID HERE> createSkillRoutes :: auto-generated pointer for public function createSkillRoutes
export function createSkillRoutes(storage: StorageService) {
  return createArtifactRoutes(storage, "skills");
}
