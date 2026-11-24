// Live check (production, smoke account) for profile and account workflows no
// test drove before the workflow matrix (docs/WORKFLOW_MATRIX.md, 2026-11-24):
//
//   profile   create a person → rename (fields kept) → photo on → photo off → delete
//   settings  a preference round-trips; reserved keys are refused
//   session   who am I; no token and a junk token are refused; a wrong
//             password is refused; the password and reset forms refuse bad input
//   export    the account export answers and contains what was just made
//
// It never changes the smoke account's password, sends no email and never
// calls the delete-everything route. Takes the gate lock.
//   npx tsx tests/live-profile-account-workflows-check.ts
import { api, getSmokeToken } from "./smoke/fixture/api";
import { API_BASE, SMOKE_EMAIL } from "./smoke/fixture/account";
import { NO_SUCH_ID, detail, list, refused, runWorkflowCheck } from "./helpers/live-workflow";

// A 1×1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** A request with no Authorization header, or the one given. */
async function raw(method: string, path: string, body?: any, token?: string) {
  const r = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => null) as any };
}

runWorkflowCheck("live-profile-account-workflows-check", async ({ tag, check, call, cleanup, section }) => {
  // ── Profile ─────────────────────────────────────────────────────────────
  section("profile");
  const made = await call("POST", "/profiles", { type: "person", name: `${tag} Tester`, fields: { relationship: "friend", phone: "555-0100" } });
  check(made.ok && !!made.data?.id, `create a person (${detail(made)})`);
  const pid: string = made.data?.id;
  if (pid) {
    cleanup(() => api("DELETE", `/profiles/${pid}`));
    const inList = () => call("GET", "/profiles").then((r) => list(r.data).find((p) => p.id === pid));
    const one = () => call("GET", `/profiles/${pid}`).then((r) => r.data);
    check((await inList())?.name === `${tag} Tester`, "they are in the profiles list");
    const renamed = await call("PATCH", `/profiles/${pid}`, { name: `${tag} Tester II` });
    const after = await one();
    check(renamed.ok && after?.name === `${tag} Tester II`, `rename → the profile shows the new name (${renamed.status})`);
    check(after?.fields?.phone === "555-0100" && after?.fields?.relationship === "friend", "a rename left the phone and relationship alone");
    check(refused(await call("PATCH", `/profiles/${pid}`, { name: "" })), "a blank name is refused");

    const photo = await call("POST", `/profiles/${pid}/photo`, { fileData: PNG, mimeType: "image/png" });
    const withPhoto = await one();
    check(photo.ok && typeof withPhoto?.avatar === "string" && withPhoto.avatar.length > 0, `add a photo → the profile has a picture (${detail(photo)})`);
    check((await inList())?.avatar === withPhoto?.avatar, "the list shows the same picture");
    check((await call("POST", `/profiles/${pid}/photo`, { fileData: PNG, mimeType: "application/pdf" })).status === 415, "a PDF as a photo is refused (415)");
    check(refused(await call("POST", `/profiles/${pid}/photo`, {})), "a photo with no file is refused");
    check((await call("POST", `/profiles/${NO_SUCH_ID}/photo`, { fileData: PNG, mimeType: "image/png" })).status === 404, "a photo for a profile that does not exist is a 404");
    const noPhoto = await call("DELETE", `/profiles/${pid}/photo`);
    check(noPhoto.ok && !(await one())?.avatar, `remove the photo → no picture (${noPhoto.status})`);
    check((await one())?.name === `${tag} Tester II`, "removing the photo left the name alone");
    const ghost = await call("DELETE", `/profiles/${NO_SUCH_ID}/photo`);
    check(ghost.status === 404, `removing the photo of a profile that does not exist is a 404 (${detail(ghost)})`);

    const del = await call("DELETE", `/profiles/${pid}`);
    check(del.ok && !(await inList()) && (await call("GET", `/profiles/${pid}`)).status === 404, `delete → gone from the list and a 404 by id (${del.status})`);
    check((await call("DELETE", `/profiles/${pid}`)).status === 404, "deleting them a second time is a 404");
  }
  check(refused(await call("POST", "/profiles", { type: "person" })), "a profile with no name is refused");

  // ── Settings ────────────────────────────────────────────────────────────
  section("settings");
  const key = `wf_check_${tag.toLowerCase()}`;
  const put = await call("PUT", `/preferences/${key}`, { value: "on" });
  cleanup(() => api("PUT", `/preferences/${key}`, { value: "" }));
  check(put.ok && (await call("GET", `/preferences/${key}`)).data?.value === "on", `a preference saves and reads back (${put.status})`);
  await call("PUT", `/preferences/${key}`, { value: "off" });
  check((await call("GET", `/preferences/${key}`)).data?.value === "off", "writing it again replaces it");
  check(refused(await call("PUT", `/preferences/${key}`, { value: 5 })), "a non-text value is refused");
  check(refused(await call("PUT", "/preferences/oauth_token", { value: "x" })), "a reserved key (oauth_) is refused");
  check(refused(await call("PUT", "/preferences/detail_definitions", { value: "[]" })), "the characteristics catalog cannot be written through preferences");
  check((await call("GET", "/preferences/gcal_refresh_token")).status === 404, "a stored token cannot be read back");
  check((await call("GET", `/preferences/never_set_${key}`)).data?.value === null, "a preference never set reads null, not an error");
  const onboarding = await call("GET", "/onboarding-status");
  check(onboarding.ok && typeof onboarding.data === "object", `onboarding status answers (${onboarding.status})`);

  // ── Session ─────────────────────────────────────────────────────────────
  section("session");
  const token = await getSmokeToken();
  const me = await raw("GET", "/auth/me", undefined, token);
  check(me.status === 200 && me.data?.user?.email === SMOKE_EMAIL, `"who am I" names the signed-in account (${me.status})`);
  check((await raw("GET", "/auth/me")).status === 401, "with no token it is a 401");
  check((await raw("GET", "/auth/me", undefined, "x".repeat(40))).status === 401, "with a junk token it is a 401");
  check((await raw("GET", "/profiles")).status === 401, "the data API with no token is a 401");
  check((await raw("GET", "/profiles", undefined, "x".repeat(40))).status === 401, "the data API with a junk token is a 401");
  const wrong = await raw("POST", "/auth/signin", { email: SMOKE_EMAIL, password: `not-the-password-${tag}` });
  check(refused(wrong) && !wrong.data?.session && !wrong.data?.user, `a wrong password is refused and hands out no session (${wrong.status})`);
  check(refused(await raw("POST", "/auth/signin", { email: SMOKE_EMAIL })), "sign-in with no password is refused");
  const weak = await raw("POST", "/auth/change-password", { currentPassword: "whatever", newPassword: "123" }, token);
  check(weak.status === 400, `a 3-character new password is refused (${weak.status})`);
  const wrongCurrent = await raw("POST", "/auth/change-password", { currentPassword: `not-the-password-${tag}`, newPassword: `Long-enough-${tag}-pw1` }, token);
  check(wrongCurrent.status >= 400 && wrongCurrent.status < 500, `changing the password with the wrong current one is refused (${wrongCurrent.status})`);
  check((await raw("GET", "/auth/me", undefined, token)).status === 200, "… and the session still works (the password was not changed)");
  check((await raw("POST", "/auth/change-password", { currentPassword: "x", newPassword: `Long-enough-${tag}-pw1` })).status === 401, "changing a password with no session is a 401");
  check(refused(await raw("POST", "/auth/forgot-password", { email: "not-an-email" })), "a reset for something that is not an email is refused");
  check(refused(await raw("POST", "/auth/reset-password", { password: "123" })), "a reset with a 3-character password is refused");

  // ── Export ──────────────────────────────────────────────────────────────
  section("export");
  const marker = await call("POST", "/tasks", { title: `${tag} export marker` });
  if (marker.data?.id) cleanup(() => api("DELETE", `/tasks/${marker.data.id}`));
  const exp = await call("GET", "/export");
  const text = JSON.stringify(exp.data);
  check(exp.ok && text.includes(`${tag} export marker`), `the export answers and contains the task just made (${exp.status}, ${Math.round(text.length / 1024)} KB, ${exp.ms}ms)`);
  check((await raw("GET", "/export")).status === 401, "the export with no token is a 401");
});
