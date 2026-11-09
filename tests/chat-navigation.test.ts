// The `navigate` chat tool. Its result reached the browser and nothing read
// it: the assistant said "Navigating to your Trackers page now!" and the user
// stayed on the chat (found by the 2026-11-09 sweep of every chat tool).
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { chatNavigationRoute } from "../client/src/lib/chat-navigation";
import { TOOL_DEFINITIONS, executeTool } from "../server/ai-engine";

const navigateTool = (TOOL_DEFINITIONS as any[]).find((t) => t.name === "navigate");

describe("chat navigate tool reaches the router", () => {
  it("every page the tool can name resolves to a route (or is the chat itself)", async () => {
    const pages: string[] = navigateTool.input_schema.properties.page.enum;
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      // The tool's REAL result, exactly as the turn's `results` carries it.
      const result = await executeTool("navigate", { page, profileId: "p-1" }, "user-1");
      expect(result.navigateTo, `navigate(${page}) result`).toBe(page);
      const route = chatNavigationRoute([result]);
      if (page === "chat") expect(route).toBeNull();
      else expect(route, `route for page "${page}"`).toMatch(/^\/[a-z]/);
    }
  });

  it("opens the named profile, and the list when no profile was named", () => {
    expect(chatNavigationRoute([{ navigateTo: "profile_detail", profileId: "abc-123" }])).toBe("/profiles/abc-123");
    expect(chatNavigationRoute([{ navigateTo: "profile_detail" }])).toBe("/profiles");
  });

  it("finds the directive among other tool results, and ignores turns without one", () => {
    expect(chatNavigationRoute([{ tasks: { total: 3 } }, { navigateTo: "trackers" }])).toBe("/trackers");
    expect(chatNavigationRoute([{ tasks: { total: 3 } }])).toBeNull();
    expect(chatNavigationRoute(undefined)).toBeNull();
    expect(chatNavigationRoute([{ navigateTo: "somewhere_else" }])).toBeNull();
  });

  it("the chat page applies it on a live reply, not on a restored one", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../client/src/pages/chat.tsx"), "utf8");
    const onSuccess = src.slice(src.indexOf("onSuccess: (data, { userMsgId }) => {"));
    const body = onSuccess.slice(0, onSuccess.indexOf("onError:"));
    expect(body).toContain("chatNavigationRoute(data?.results)");
    expect(body).toContain("hashNavigate(route)");
    // applyChatResult also runs for a reply restored after navigation.
    const apply = src.slice(src.indexOf("const applyChatResult = useCallback"));
    expect(apply.slice(0, apply.indexOf("// ── Rule 22"))).not.toContain("chatNavigationRoute");
  });
});
