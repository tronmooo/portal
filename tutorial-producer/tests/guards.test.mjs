import {test} from 'node:test';
import assert from 'node:assert/strict';
import {config,assertIdentity,verifyEntry} from '../guards.mjs';
const env={PORTOL_TUTORIAL_EMAIL:'tutorial-studio-new@example.com',PORTOL_TUTORIAL_PASSWORD:'secret',PORTOL_TUTORIAL_USER_ID:'new-user',PORTOL_TUTORIAL_PROFILE_ID:'new-profile'};
test('missing dedicated identity fails closed',()=>assert.throws(()=>config({}),/Missing/));
test('shared smoke account rejected even with a password',()=>assert.throws(()=>config({...env,PORTOL_TUTORIAL_EMAIL:'smoke@example.com'}),/newly provisioned/));
test('foreign origin rejected',()=>assert.throws(()=>config({...env,PORTOL_BASE_URL:'https://attacker.example'}),/Unapproved/));
test('credentials in app URL rejected',()=>assert.throws(()=>config({...env,PORTOL_BASE_URL:'https://u:p@portol.me'}),/clean/));
test('mismatched server identity rejected',()=>assert.throws(()=>assertIdentity({id:'real-customer',email:env.PORTOL_TUTORIAL_EMAIL},config(env)),/mismatch/));
const tracker={fields:[{name:'distance',unit:'mi'},{name:'duration',unit:'min'}]};
const entry=()=>({profileId:'new-profile',timestamp:new Date().toISOString(),notes:'unique-run',values:{distance:2.5,duration:42}});
test('matching persisted row accepted',()=>assert.doesNotThrow(()=>verifyEntry(tracker,entry(),config(env),'unique-run')));
test('values in wrong profile rejected',()=>assert.throws(()=>verifyEntry(tracker,{...entry(),profileId:'customer'},config(env),'unique-run'),/owner/));
test('unrelated numeric fields cannot fake success',()=>assert.throws(()=>verifyEntry(tracker,{...entry(),values:{foo:2.5,bar:42}},config(env),'unique-run'),/fields/));
test('kilometers cannot be described as miles',()=>assert.throws(()=>verifyEntry({fields:[{name:'distance',unit:'km'}]},entry(),config(env),'unique-run'),/unit/));
test('old duplicate values rejected by unique marker',()=>assert.throws(()=>verifyEntry(tracker,{...entry(),notes:'old'},config(env),'unique-run'),/marker/));

test('seconds cannot be described as minutes',()=>assert.throws(()=>verifyEntry({fields:[{name:'distance',unit:'mi'},{name:'duration',unit:'sec'}]},entry(),config(env),'unique-run'),/Duration unit/));
