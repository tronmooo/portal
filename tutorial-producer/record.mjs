import {chromium} from 'playwright';
import {mkdir, writeFile, copyFile, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {config, assertIdentity, verifyEntry} from './guards.mjs';

const c = config(); // Fail before a browser or a write when isolation is unconfigured.
const out = resolve('tutorial-output');
await mkdir(join(out,'raw/screenshots'),{recursive:true});
await mkdir(join(out,'raw/video'),{recursive:true});
const runId = randomUUID();
const marker = `Tutorial ${runId}`;
const report = {runId,startedAt:new Date().toISOString(),commit:process.env.GITHUB_SHA || null,base:c.base,accountId:c.userId,profileId:c.profileId,status:'blocked',scenes:[],defects:[],publicPublishing:false};
const browser = await chromium.launch({headless:true});
let recordingContext, page, started;
const auth = await browser.newContext(); // Authentication is NEVER recorded or uploaded.
const login = await auth.newPage();
const api = async(path) => {
  const response = await auth.request.get(c.base+path,{headers:{Authorization:`Bearer ${token}`}});
  if (!response.ok()) throw new Error(`Read-only verification failed (${response.status()})`);
  return response.json();
};
let token;
let activeScene;
const screenshot = async(name) => {
  const path=join(out,'raw/screenshots',`${name}.png`);
  await page.screenshot({path});
  return path;
};
const scene = async(id,objective,action) => {
  activeScene={scene_id:id,learning_objective:objective,app_route:page.url(),test_profile:c.profileId,startedAt:new Date().toISOString(),start:(Date.now()-started)/1000,verification_status:'blocked',screenshot_paths:[],action_steps:[],expected_result:objective};
  report.scenes.push(activeScene);
  if(page.url().startsWith(c.base)) await page.evaluate(n=>{localStorage.setItem('__tutorial_scene',String(n)); const m=document.getElementById('__tutorial_marker'); if(m) m.style.background=['#fa00fa','#00fa00','#0000fa','#fafa00','#00fafa'][n-1];},report.scenes.length);
  try {
    await action(activeScene);
    activeScene.screenshot_paths.push(await screenshot(id));
    await page.waitForTimeout(1800); // Readable outcome hold, not a synchronization substitute.
    activeScene.verification_status='pass';
    activeScene.actual_result=objective;
  } catch(error) {
    activeScene.verification_status='fail';
    activeScene.actual_result=String(error.message).replaceAll(c.password,'[redacted]').replaceAll(token || 'NO_TOKEN','[redacted]');
    activeScene.screenshot_paths.push(await screenshot(`${id}-failure`));
    report.defects.push({id:`DEF-${report.defects.length+1}`,scene:id,reproduction:activeScene.action_steps,expected:objective,actual:activeScene.actual_result,screenshots:activeScene.screenshot_paths});
    throw error;
  } finally {activeScene.app_route=page.url(); activeScene.end=(Date.now()-started)/1000;}
};
const click = async(locator) => {
  await locator.waitFor({state:'visible'});
  await locator.scrollIntoViewIfNeeded();
  const box=await locator.boundingBox();
  if (!box) throw new Error('Control has no visible bounds');
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2,{steps:18});
  await locator.click();
};
try {
  await login.goto(c.base,{waitUntil:'domcontentloaded'});
  await login.getByTestId('input-signin-email').fill(c.email);
  await login.getByTestId('input-signin-password').fill(c.password);
  await login.getByTestId('button-signin').click();
  await login.waitForFunction(()=>!!localStorage.getItem('portol_session'),{},{timeout:60000});
  token = await login.evaluate(()=>JSON.parse(localStorage.getItem('portol_session')).access_token);
  assertIdentity((await api('/api/auth/me')).user,c);
  const profiles=await api('/api/profiles');
  if (!Array.isArray(profiles) || !profiles.some(p=>p.id===c.profileId && p.name==='Tutorial Studio')) throw new Error('Dedicated test profile not confirmed');
  // No storage-state file is ever written to disk.
  recordingContext=await browser.newContext({storageState:await auth.storageState(),viewport:{width:1920,height:1080},timezoneId:'UTC',recordVideo:{dir:join(out,'raw/video'),size:{width:1920,height:1080}}});
  await recordingContext.addInitScript(()=>{
    document.addEventListener('DOMContentLoaded',()=>{
      const n=Number(localStorage.getItem('__tutorial_scene') || 1);
      const marker=document.createElement('div'); marker.id='__tutorial_marker';
      marker.style.cssText='position:fixed;top:0;left:0;width:16px;height:16px;z-index:2147483647;pointer-events:none';
      marker.style.background=['#fa00fa','#00fa00','#0000fa','#fafa00','#00fafa'][n-1]; document.body.append(marker);
    });
  });
  page=await recordingContext.newPage();
  page.setDefaultTimeout(30000);
  started=Date.now();
  await scene('01-identity','Show the dedicated Tutorial Studio profile before writing',async(s)=>{
    s.action_steps.push('Open Trackers, select only Tutorial Studio in the profile switcher, and confirm the visible scope');
    await page.goto(c.base+'/#/trackers');
    await click(page.getByTestId('hub-profile-switcher'));
    await click(page.getByTestId(`hub-switch-${c.profileId}`));
    await page.getByTestId('hub-profile-switcher').filter({hasText:'Tutorial Studio'}).waitFor();
    s.narration_text='This walkthrough uses a dedicated test account and the Tutorial Studio profile.';
  });
  await scene('02-chat','Submit a synthetic walking entry through real chat',async(s)=>{
    await page.goto(c.base+'/#/chat');
    const prompt=`For the Tutorial Studio profile only, create a tracker named "${marker}" for walking. Log 2.5 miles and 42 minutes today. Include "${marker}" in the entry notes. Do not change any other profile.`;
    s.action_steps.push('Open Chat',prompt,'Send the message once');
    await page.getByTestId('input-chat').pressSequentially(prompt,{delay:22});
    await click(page.getByTestId('button-send'));
    // Wait for persistence, not an arbitrary delay or a chat success claim.
    let verified;
    for(let attempt=0;attempt<60;attempt++) {
      const trackers=await api('/api/trackers');
      const tracker=Array.isArray(trackers) && trackers.find(t=>t.name===marker);
      if (tracker) for(const entry of tracker.entries || []) {
        try {verifyEntry(tracker,entry,c,marker); verified={tracker,entry}; break;} catch {}
      }
      if(verified) break;
      await page.waitForTimeout(2000);
    }
    if(!verified) throw new Error('Chat write did not persist exact owner, marker, values, units and date');
    report.trackerId=verified.tracker.id;
    report.entryId=verified.entry.id;
    s.narration_text='In Chat, describe the activity and name the profile. Here we log a two point five mile walk that took forty two minutes.';
  });
  await scene('03-tracker-list','Find the exact new tracker in compact list view',async(s)=>{
    s.action_steps.push('Navigate to Trackers','Switch to compact list','Find the tracker created by this run');
    await page.goto(c.base+'/#/trackers');
    const toggle=page.getByTestId('view-toggle');
    await toggle.waitFor();
    if(await toggle.getAttribute('data-view')!=='table') await click(toggle);
    await page.getByTestId(`linked-list-row-tracker-${report.trackerId}`).waitFor();
    s.narration_text='Open Trackers, then switch to the compact list. Find the tracker created by this request.';
  });
  const history = async()=>{
    await click(page.getByTestId(`linked-list-row-tracker-${report.trackerId}`));
    const dialog=page.getByTestId('tracker-detail-dialog');
    await click(dialog.getByTestId('tab-history'));
    const row=dialog.getByTestId(`entry-row-${report.entryId}`);
    await row.waitFor();
    const text=await row.innerText();
    if(!/\b2\.5\s*(mi|miles?)\b/i.test(text)||!/(^|\D)42(\D|$)/.test(text)||!text.includes(marker)) throw new Error('Exact history row does not visibly match values, unit and run marker');
    await dialog.getByTestId('history-day-header').filter({hasText:/Today/}).first().waitFor();
  };
  await scene('04-history','Verify the exact entry in tracker history',async(s)=>{
    s.action_steps.push('Open the exact tracker','Select History','Check exact entry id, values, miles unit, date and notes');
    await history();
    s.narration_text='Open the tracker and select History. The matching row shows two point five miles, forty two minutes, and the unique note from our request.';
  });
  await scene('05-reload','Verify the same history row after reload',async(s)=>{
    s.action_steps.push('Reload Trackers','Reopen the same tracker and History','Recheck persistence and owner');
    await page.reload();
    await history();
    assertIdentity((await api('/api/auth/me')).user,c);
    const tracker=(await api('/api/trackers')).find(t=>t.id===report.trackerId);
    verifyEntry(tracker,tracker.entries.find(e=>e.id===report.entryId),c,marker);
    s.narration_text='Reload and reopen the tracker. The same entry is still here. This confirms the result was saved, beyond the chat response.';
  });
  report.status='pass';
} catch(error) {
  report.status=report.scenes.length?'fail':'blocked';
  report.error=String(error.message).replaceAll(c.password,'[redacted]').replaceAll(token || 'NO_TOKEN','[redacted]');
  process.exitCode=1;
} finally {
  if(recordingContext){
    const video=page.video();
    await recordingContext.close();
    if(video){await copyFile(await video.path(),join(out,'raw/video/raw.webm')); await rm(await video.path());}
  }
  await auth.close(); await browser.close();
  report.finishedAt=new Date().toISOString();
  await writeFile(join(out,'manifest.json'),JSON.stringify(report,null,2));
  await writeFile(join(out,'defects.json'),JSON.stringify(report.defects,null,2));
  console.log(`Tutorial capture ${report.status}; evidence: tutorial-output/manifest.json`);
}
