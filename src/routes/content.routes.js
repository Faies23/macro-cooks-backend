const router = require('express').Router();
const { query } = require('../db');
const { authRequired } = require('../auth');
const adminOnly = require('../middleware/adminOnly');
const cf = require('../video/cloudflareStream');
const planEngine = require('../content/plan');

// Wrap async handlers so rejections reach the central error middleware instead of hanging.
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// List published classes. Free classes play for everyone; premium classes only reveal a
// playback URL to users holding an ACTIVE 'full' entitlement — otherwise we withhold the URL
// (playbackUrl:null, locked:true) so the gate is enforced server-side, not just in the app.
router.get('/classes', authRequired, wrap(async (req, res) => {
  const ent = await query(
    "select 1 from entitlements where user_id=$1 and product='full' and expires_at > now() limit 1",
    [req.user.id]
  );
  const hasFull = ent.rows.length > 0;

  const r = await query('select id,"by",title,free,uid from classes order by created_at desc');
  const classes = r.rows.map(c => {
    const free = !!c.free;
    const unlocked = free || hasFull;
    // SECURITY: never expose the Cloudflare uid to users without access — the playback URL
    // is a pure function of the uid, so leaking it defeats the gate. Only emit uid/playbackUrl
    // when unlocked. (For stronger protection, enable Cloudflare Stream signed URLs.)
    return {
      id: c.id,
      title: c.title,
      by: c.by,
      free,
      ...(unlocked ? { uid: c.uid, playbackUrl: cf.playbackUrl(c.uid) } : { playbackUrl: null, locked: true })
    };
  });
  res.json({ classes });
}));

// Admin: get a one-time direct-upload URL for Cloudflare Stream.
router.post('/admin/upload-url', authRequired, adminOnly, wrap(async (req, res) => {
  try { res.json(await cf.createDirectUpload({ maxDurationSeconds: 60 * 60 })); }
  catch (e) { console.error('upload-url error:', e); res.status(502).json({ error: 'upload url failed' }); }
}));

// Admin: save a published class after the video was uploaded (client got the uid).
//    Body: { title, by, free, uid }
router.post('/admin/classes', authRequired, adminOnly, wrap(async (req, res) => {
  const { title, by, free, uid } = req.body || {};
  if (typeof title !== 'string' || !title.trim() || typeof uid !== 'string' || !uid.trim())
    return res.status(400).json({ error: 'title and uid required' });
  if (title.length > 200 || uid.length > 100 || (by != null && (typeof by !== 'string' || by.length > 100)))
    return res.status(400).json({ error: 'invalid field length' });
  const r = await query(
    'insert into classes(title,"by",free,uid) values($1,$2,$3,$4) returning id',
    [title.trim(), (typeof by === 'string' ? by.trim() : null) || null, !!free, uid.trim()]
  );
  res.json({ id: r.rows[0].id, ok: true });
}));

router.delete('/admin/classes/:id', authRequired, adminOnly, wrap(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  await query('delete from classes where id=$1', [req.params.id]);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------
 * PAID CONTENT: the meal plan and the recipe library.
 *
 * These used to be generated inside the app, which meant the food table and the generator
 * were sitting in every browser. Anyone could read them, or set the unlock flags from the
 * console, and have the paid plan for nothing. Generating here means an unpaid client is
 * never sent the days it has not paid for, so there is nothing to unlock.
 *
 * Free tier: day 1 only. 'plan', 'recipes' or 'full' unlock all seven days.
 * Recipes need 'recipes' or 'full'.
 * ------------------------------------------------------------------ */

const FREE_DAYS = 1;
const PLAN_PRODUCTS = ['plan', 'recipes', 'full'];
const RECIPE_PRODUCTS = ['recipes', 'full'];

async function activeProducts(userId) {
  const r = await query(
    'select distinct product from entitlements where user_id=$1 and expires_at > now()',
    [userId]
  );
  return r.rows.map(x => x.product);
}

// Four food names were corrected in November 2026. Apps installed before that (Android 2.6 and
// earlier) carry their own name rules and translation files, and do not know the new spellings:
// their meal lines would fall back to English and Maandazi would lose its High GI badge. The
// new app says it knows them by sending names=2; everyone else keeps getting the old spellings.
const LEGACY_NAMES = [
  ['Chickpeas (dengu)', 'Chickpeas (mbaazi)'],
  ['Lentils (adesi)', 'Lentils (dengu)'],
  ['red lentils (adesi)', 'red lentils (dengu)'],
  ['African eggplant (nyanya chungu)', 'African eggplant (ngogwe)'],
  ['Maandazi', 'Mandazi']
];
function forClient(req, payload) {
  const v = (req.body && req.body.names) || (req.query && req.query.names);
  if (String(v) === '2') return payload;
  let s = JSON.stringify(payload);
  LEGACY_NAMES.forEach(([now, old]) => { s = s.split(now).join(old); });
  return JSON.parse(s);
}

// The app posts the profile it collected during onboarding. Nothing here is trusted for
// access: entitlement is read from the database, never from the request.
function readProfile(body) {
  const b = body || {};
  const p = b.profile || b;
  const nums = ['age', 'weight', 'height'];
  const out = {
    sex: p.sex === 'male' ? 'male' : 'female',
    activity: typeof p.activity === 'string' ? p.activity : 'light',
    goal: typeof p.goal === 'string' ? p.goal : 'maintain',
    diet: typeof p.diet === 'string' ? p.diet : 'omnivore',
    favs: Array.isArray(p.favs) ? p.favs.filter(x => typeof x === 'string').slice(0, 10) : [],
    conditions: Array.isArray(p.conditions) ? p.conditions.filter(x => typeof x === 'string').slice(0, 10) : []
  };
  nums.forEach(k => {
    const v = Number(p[k]);
    out[k] = Number.isFinite(v) && v > 0 && v < 1000 ? v : 0;
  });
  return out;
}

router.post('/plan', authRequired, wrap(async (req, res) => {
  const profile = readProfile(req.body);
  if (!profile.weight || !profile.height || !profile.age) {
    return res.status(400).json({ error: 'Complete your profile first' });
  }
  const products = await activeProducts(req.user.id);
  const unlocked = products.some(p => PLAN_PRODUCTS.includes(p));
  const targets = planEngine.computeTargets(profile);
  const days = planEngine.buildPlan(profile, targets, unlocked ? 7 : FREE_DAYS);
  res.json(forClient(req, {
    targets,
    days,
    unlocked,
    totalDays: 7,
    monthKey: planEngine.monthKey(),
    locked: unlocked ? 0 : 7 - FREE_DAYS
  }));
}));

// Reshuffle a single day. Day 1 is free; the rest need an active plan.
router.post('/plan/day', authRequired, wrap(async (req, res) => {
  const profile = readProfile(req.body);
  if (!profile.weight || !profile.height || !profile.age) {
    return res.status(400).json({ error: 'Complete your profile first' });
  }
  const dayIndex = Math.max(0, Math.min(6, parseInt(req.body && req.body.day, 10) || 0));
  const products = await activeProducts(req.user.id);
  const unlocked = products.some(p => PLAN_PRODUCTS.includes(p));
  if (dayIndex >= FREE_DAYS && !unlocked) {
    return res.status(402).json({ error: 'Subscribe to unlock the full week' });
  }
  // Reshuffling is part of what the plan is sold for. An unpaid account is allowed to see
  // day one, but it kept its own nonce, and ten thousand different nonces meant ten thousand
  // different free days: not the paid week exactly, but enough variety that paying for it
  // stopped being the point. Pinning the nonce to zero leaves the free preview as one fixed
  // day, which is what it was always described as.
  const nonce = unlocked
    ? Math.max(0, Math.min(9999, parseInt(req.body && req.body.nonce, 10) || 0))
    : 0;
  const targets = planEngine.computeTargets(profile);
  res.json(forClient(req, { day: dayIndex, meals: planEngine.buildDay(profile, targets, dayIndex, nonce * 7).meals }));
}));

router.get('/recipes', authRequired, wrap(async (req, res) => {
  const products = await activeProducts(req.user.id);
  const unlocked = products.some(p => RECIPE_PRODUCTS.includes(p));
  if (!unlocked) {
    // Titles only, so the app can show what is on offer without giving it away.
    return res.json(forClient(req, {
      unlocked: false,
      recipes: planEngine.RECIPES.map(r => ({ id: r.id, title: r.title, meta: r.meta, locked: true }))
    }));
  }
  res.json(forClient(req, { unlocked: true, recipes: planEngine.RECIPES }));
}));

module.exports = router;
