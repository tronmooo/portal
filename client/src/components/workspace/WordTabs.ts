// Word's own navigation, shared by the Word workspace (documents, templates,
// AI Writer, AI Review, version history) and the document editor, so the two
// screens read as one app (owner request 2026-11-25).
import { FileSearch, FileText, History, LayoutTemplate, PenLine, Wand2 } from "lucide-react";
import type { WorkspaceTab } from "./WorkspaceApp";

export type WordTab = "documents" | "editor" | "templates" | "writer" | "review" | "history";
export const WORD_TABS: WorkspaceTab<WordTab>[] = [
  { id: "documents", label: "My Documents", icon: FileText },
  { id: "editor", label: "Editor", icon: PenLine },
  { id: "templates", label: "Templates", icon: LayoutTemplate },
  { id: "writer", label: "AI Writer", icon: Wand2 },
  { id: "review", label: "AI Review", icon: FileSearch },
  { id: "history", label: "Version History", icon: History },
];
export const isWordTab = (v: unknown): v is WordTab => WORD_TABS.some((t) => t.id === v);

/** Where a Word tab lives. The Editor is the document editor; the rest are the workspace. */
export function wordTabRoute(tab: WordTab, docId?: string | null): string {
  if (tab === "editor") return docId ? `/editor/${docId}?source=word` : "/editor/new/doc?source=word";
  return `/workspace/word?tab=${tab}${docId ? `&doc=${docId}` : ""}`;
}

/**
 * Content handed from the workspace to the editor: a template, or a document
 * the AI wrote, that the user chose to open. It is held in memory for the one
 * navigation and taken once — the EDITOR saves it, the same way it saves
 * anything typed (so "Use template" by itself writes nothing).
 */
export interface WordSeed {
  title?: string;
  html: string;
  /** Replace the text of this saved document (an AI revision the user accepted). */
  forId?: string;
}
let pending: WordSeed | null = null;
export function setWordSeed(seed: WordSeed): void { pending = seed; }
export function takeWordSeed(fits: (seed: WordSeed) => boolean): WordSeed | null {
  if (!pending || !fits(pending)) return null;
  const seed = pending;
  pending = null;
  return seed;
}
export function clearWordSeed(): void { pending = null; }
