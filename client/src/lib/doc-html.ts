// The document editor's HTML, cleaned for saving, and pictures made small
// enough to live inside a document.
import DOMPurify from "dompurify";
import { DOC_ALLOWED_ATTR, DOC_ALLOWED_TAGS, tightenDocHtml } from "@shared/page-setup";

export function cleanDocHtml(html: string): string {
  return tightenDocHtml(DOMPurify.sanitize(html || "", { ALLOWED_TAGS: DOC_ALLOWED_TAGS, ALLOWED_ATTR: DOC_ALLOWED_ATTR }));
}

export const DOC_IMAGE_MAX_SIDE = 1400;
/** A document holds at most ~2 MB of HTML; one picture gets a share of it. */
export const DOC_IMAGE_MAX_CHARS = 450_000;

/** Read a picture, scale it down and return it as a JPEG/PNG data URL. */
export async function imageFileToDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("That file is not a picture.");
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Couldn't read that picture."));
      el.src = url;
    });
    let side = DOC_IMAGE_MAX_SIDE;
    for (let attempt = 0; attempt < 4; attempt++) {
      const scale = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Couldn't process that picture.");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL("image/jpeg", 0.82);
      if (data.length <= DOC_IMAGE_MAX_CHARS) return data;
      side = Math.round(side * 0.7);
    }
    throw new Error("That picture is too large to put in a document.");
  } finally {
    URL.revokeObjectURL(url);
  }
}
