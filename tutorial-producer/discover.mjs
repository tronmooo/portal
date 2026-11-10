import {readFile, writeFile, mkdir} from 'node:fs/promises';
// Source inventory is a coverage queue, never proof that a feature works.
const source = await readFile('client/src/App.tsx','utf8');
const features = [...source.matchAll(/<Route path="([^"]+)" component=\{([^}]+)\}/g)].map(m=>({route:m[1],component:m[2],status:'untested',evidence:[]}));
await mkdir('tutorial-output',{recursive:true});
await writeFile('tutorial-output/feature-inventory.json',JSON.stringify({generatedAt:new Date().toISOString(),source:'client/src/App.tsx',features},null,2));
console.log(`Discovered ${features.length} route entries; all start untested.`);
