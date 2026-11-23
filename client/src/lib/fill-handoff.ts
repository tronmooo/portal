// A file on its way to the Fill In workspace from another screen (a chat
// attachment, a "Fill a form" button on a profile). Held in memory for the
// one navigation: nothing is stored, and the workspace takes it once.
export interface PendingFillFile { name: string; mimeType: string; base64: string }

let pending: PendingFillFile | null = null;

export function setPendingFillFile(file: PendingFillFile): void { pending = file; }
export function takePendingFillFile(): PendingFillFile | null {
  const f = pending;
  pending = null;
  return f;
}
