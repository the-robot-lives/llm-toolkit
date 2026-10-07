import { createContext, useContext, type Dispatch, type SetStateAction } from "react";

export type FocusZone = "header" | "sidebar" | "controls" | "content";

export interface FocusContextValue {
  focusZone: FocusZone;
  setFocusZone?: Dispatch<SetStateAction<FocusZone>>;
  setTrapContentTab?: Dispatch<SetStateAction<boolean>>;
}

const Context = createContext<FocusContextValue>({ focusZone: "content" });

export const FocusProvider = Context.Provider;

// <REMOVED UUID HERE> useFocusZone :: auto-generated pointer for public function useFocusZone
export function useFocusZone(): FocusZone {
  return useContext(Context).focusZone;
}

// <REMOVED UUID HERE> useFocusContext :: auto-generated pointer for public function useFocusContext
export function useFocusContext(): FocusContextValue {
  return useContext(Context);
}
