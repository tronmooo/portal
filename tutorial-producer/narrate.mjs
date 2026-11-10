import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const root=resolve('tutorial-output');
const manifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));
if(manifest.status!=='pass'||manifest.scenes.some(s=>s.verification_status!=='pass')) throw new Error('Narration requires verified scenes');
const characters=manifest.scenes.reduce((n,s)=>n+s.narration_text.length,0);
console.log(`Narration estimate: ${characters} characters; provider billing depends on your ElevenLabs plan.`);
if(process.argv.includes('--estimate')) process.exit(0);
const limit=Number(process.env.ELEVENLABS_APPROVED_CHARACTER_LIMIT || 0);
if(!Number.isFinite(limit)||characters>limit) throw new Error('Character usage exceeds approved limit');
if(!process.env.ELEVENLABS_API_KEY) throw new Error('Missing ElevenLabs runner credential');
const dir=join(root,'audio/narration'); await mkdir(dir,{recursive:true});
for(const scene of manifest.scenes){
  const r=await fetch('https://api.elevenlabs.io/v1/text-to-speech/hpp4J3VqNfWAUOO0d1Us',{method:'POST',headers:{'xi-api-key':process.env.ELEVENLABS_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({text:scene.narration_text,model_id:'eleven_multilingual_v2',voice_settings:{stability:0.55,similarity_boost:0.75,speed:0.98}})});
  if(!r.ok) throw new Error(`Speech generation failed: ${r.status}`);
  await writeFile(join(dir,scene.scene_id+'.mp3'),Buffer.from(await r.arrayBuffer()));
}
