export function config(env = process.env) {
  const required = ['PORTOL_TUTORIAL_EMAIL', 'PORTOL_TUTORIAL_PASSWORD', 'PORTOL_TUTORIAL_USER_ID', 'PORTOL_TUTORIAL_PROFILE_ID'];
  for (const key of required) if (!env[key]) throw new Error(`Missing ${key}`);
  if (!/^tutorial-studio-[a-z0-9-]+@example\.com$/.test(env.PORTOL_TUTORIAL_EMAIL)) throw new Error('Only a newly provisioned tutorial-studio account is allowed');
  const base = new URL(env.PORTOL_BASE_URL || 'https://portol.me');
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('Expected a clean HTTPS origin');
  if (!['portol.me', 'portal-cyan-nine.vercel.app'].includes(base.hostname) && !/^portal-[a-z0-9-]+-tronmooos-projects\.vercel\.app$/.test(base.hostname)) throw new Error('Unapproved app origin');
  return {base: base.origin, email: env.PORTOL_TUTORIAL_EMAIL, password: env.PORTOL_TUTORIAL_PASSWORD, userId: env.PORTOL_TUTORIAL_USER_ID, profileId: env.PORTOL_TUTORIAL_PROFILE_ID};
}
export function assertIdentity(user, c) {
  if (user?.id !== c.userId || user?.email !== c.email) throw new Error('Account identity mismatch: refusing all writes');
}
export function verifyEntry(tracker, entry, c, marker) {
  if (entry.profileId !== c.profileId) throw new Error('Entry owner mismatch');
  if (!JSON.stringify(entry).includes(marker)) throw new Error('Run marker missing');
  const values = entry.values || {};
  const miles = Object.entries(values).find(([k,v]) => /distance|miles/i.test(k) && Number(v) === 2.5);
  const minutes = Object.entries(values).find(([k,v]) => /duration|minutes/i.test(k) && Number(v) === 42);
  if (!miles || !minutes) throw new Error('Exact distance/duration fields not persisted');
  const field = tracker.fields?.find(f => f.name === miles[0]);
  if (!/^(mi|mile|miles)$/i.test(field?.unit || tracker.unit || '')) throw new Error('Distance unit is not miles');
  const durationField=tracker.fields?.find(f=>f.name===minutes[0]);
  if (!/^(min|minute|minutes)$/i.test(durationField?.unit || '')) throw new Error('Duration unit is not minutes');
  if (new Date(entry.timestamp).toISOString().slice(0,10) !== new Date().toISOString().slice(0,10)) throw new Error('Entry date mismatch');
}
