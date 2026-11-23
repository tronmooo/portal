// The Document workspace's tables, pictures and page setup (owner request
// 2026-11-23). Pure rules: what a saved document may contain, how its page is
// stored, and that a picture never travels to the AI and is never lost by it.
import { describe, it, expect } from "vitest";
import {
  DEFAULT_PAGE_SETUP, pageBox, parsePageSetup, serializePageSetup, tightenDocHtml,
} from "../shared/page-setup";
import { markersToPictures, picturesToMarkers, sanitizeDocumentHtml } from "../shared/workspace-document";

describe("page setup", () => {
  it("round-trips through the one stored value", () => {
    const s = { size: "a4", orientation: "landscape", margins: "narrow" } as const;
    expect(serializePageSetup(s)).toBe("page:a4;landscape;narrow");
    expect(parsePageSetup("page:a4;landscape;narrow")).toEqual(s);
  });

  it("anything else reads as the default page", () => {
    for (const raw of [undefined, "", "javascript", "page:tabloid;sideways;huge"]) {
      expect(parsePageSetup(raw)).toEqual(DEFAULT_PAGE_SETUP);
    }
  });

  it("landscape turns the paper; margins are the padding", () => {
    expect(pageBox({ size: "letter", orientation: "portrait", margins: "normal" })).toMatchObject({ widthPx: 816, heightPx: 1056, paddingPx: 96 });
    expect(pageBox({ size: "letter", orientation: "landscape", margins: "wide" })).toMatchObject({ widthPx: 1056, heightPx: 816, paddingPx: 144, widthPt: 792, heightPt: 612 });
  });
});

describe("what a saved document keeps", () => {
  it("a style keeps only its alignment", () => {
    expect(tightenDocHtml('<p style="text-align: center; position: fixed; top: 0">x</p>')).toBe('<p style="text-align: center">x</p>');
    expect(tightenDocHtml('<p style="background: url(javascript:1)">x</p>')).toBe("<p>x</p>");
  });

  it("a picture is kept only when it is embedded or https", () => {
    const ok = '<img src="data:image/png;base64,iVBORw0KGgo=" alt="a">';
    expect(tightenDocHtml(ok)).toBe(ok);
    expect(tightenDocHtml('<img src="https://example.test/a.png">')).toBe('<img src="https://example.test/a.png">');
    expect(tightenDocHtml('<p>a</p><img src="javascript:alert(1)"><img src="data:text/html;base64,AAAA"><img src="http://example.test/a.png">')).toBe("<p>a</p>");
  });
});

describe("pictures and the AI", () => {
  const A = '<img src="data:image/png;base64,AAAA" alt="one">';
  const B = '<img src="data:image/jpeg;base64,BBBB" alt="two">';

  it("a picture goes out as a marker and comes back as itself", () => {
    const sent = picturesToMarkers(`<p>Intro</p>${A}<p>Middle</p>${B}`);
    expect(sent.html).toBe("<p>Intro</p><p>[[PICTURE 1]]</p><p>Middle</p><p>[[PICTURE 2]]</p>");
    expect(sent.html).not.toContain("base64");
    // The model moved one and kept the other.
    const back = markersToPictures("<p>[[PICTURE 2]]</p><p>A warmer intro</p><p>[[PICTURE 1]]</p>", sent.pictures);
    expect(back).toBe(`${B}<p>A warmer intro</p>${A}`);
  });

  it("a picture the model dropped is put back at the end, never lost", () => {
    const sent = picturesToMarkers(`<p>Intro</p>${A}`);
    expect(markersToPictures("<p>Rewritten with no marker</p>", sent.pictures)).toBe(`<p>Rewritten with no marker</p>${A}`);
  });

  it("a marker repeated by the model yields the picture once", () => {
    const sent = picturesToMarkers(A);
    expect(markersToPictures("<p>[[PICTURE 1]]</p><p>[[PICTURE 1]]</p>", sent.pictures)).toBe(A);
  });

  it("a table in an AI draft is kept; its attributes are not", () => {
    expect(sanitizeDocumentHtml('<table class="x" onclick="y()"><tbody><tr><th>Item</th><td>Cost</td></tr></tbody></table>'))
      .toBe("<table><tbody><tr><th>Item</th><td>Cost</td></tr></tbody></table>");
  });
});
