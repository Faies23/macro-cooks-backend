/*
 * Meal-plan engine. This used to live in the app itself, which meant the food table and the
 * generator shipped to every browser: anyone could read them, or simply flip the unlock flags
 * in the console, and get the paid plan without paying. Generating here instead means an
 * unpaid client is never sent the days it has not bought, so there is nothing to unlock.
 *
 * The logic is a straight port of the original client code, so an existing customer's plan
 * for a given month comes out identical.
 */

const FOODS = [
  /* Carbs / starches */
  { n: "Ugali (maize)", e: "\u{1F35A}", kcal: 218, p: 5, c: 48, f: 1, tag: ["carb", "ea"] },
  { n: "Wali (rice)", e: "\u{1F35A}", kcal: 205, p: 4, c: 45, f: 0, tag: ["carb", "ea"] },
  { n: "Brown rice", e: "\u{1F35A}", kcal: 216, p: 5, c: 45, f: 2, tag: ["carb"] },
  { n: "Chapati", e: "\u{1FAD3}", kcal: 300, p: 8, c: 46, f: 9, tag: ["carb", "ea"] },
  { n: "Sweet potato (kiazi kitamu)", e: "\u{1F360}", kcal: 180, p: 4, c: 41, f: 0, tag: ["carb", "ea"] },
  { n: "Boiled cassava (muhogo)", e: "\u{1F954}", kcal: 190, p: 2, c: 45, f: 0, tag: ["carb", "ea"] },
  { n: "Green plantain (ndizi)", e: "\u{1F34C}", kcal: 215, p: 2, c: 57, f: 0, tag: ["carb", "ea"] },
  { n: "Oats", e: "\u{1F963}", kcal: 150, p: 5, c: 27, f: 3, tag: ["carb", "bf"] },
  { n: "Whole-wheat bread", e: "\u{1F35E}", kcal: 160, p: 8, c: 28, f: 2, tag: ["carb", "bf"] },
  { n: "Millet porridge (uji)", e: "\u{1F963}", kcal: 140, p: 4, c: 27, f: 2, tag: ["carb", "bf", "ea"] },
  /* Proteins, meat & fish */
  { n: "Grilled chicken", e: "\u{1F357}", kcal: 165, p: 31, c: 0, f: 4, tag: ["meat"] },
  { n: "Beef stew (mchuzi wa nyama)", e: "\u{1F969}", kcal: 240, p: 26, c: 2, f: 14, tag: ["meat", "ea"] },
  { n: "Goat meat (mbuzi)", e: "\u{1F356}", kcal: 240, p: 27, c: 0, f: 14, tag: ["meat", "ea"] },
  { n: "Nyama choma (lean beef)", e: "\u{1F969}", kcal: 250, p: 26, c: 0, f: 16, tag: ["meat", "ea"] },
  { n: "Tilapia fish (sato)", e: "\u{1F41F}", kcal: 128, p: 26, c: 0, f: 3, tag: ["meat", "ea"] },
  { n: "Mackerel (vibua)", e: "\u{1F41F}", kcal: 205, p: 25, c: 0, f: 12, tag: ["meat"] },
  { n: "Dagaa (sardines)", e: "\u{1F41F}", kcal: 180, p: 25, c: 2, f: 8, tag: ["meat", "ea"] },
  { n: "Boiled eggs (2)", e: "\u{1F95A}", kcal: 155, p: 13, c: 1, f: 11, tag: ["egg", "bf"] },
  /* Plant proteins / legumes */
  { n: "Maharage (kidney beans)", e: "\u{1FAD8}", kcal: 245, p: 15, c: 45, f: 1, tag: ["plantpro", "carb", "ea"] },
  { n: "Lentils (adesi)", e: "\u{1FAD8}", kcal: 230, p: 18, c: 40, f: 1, tag: ["plantpro", "carb"] },
  { n: "Chickpeas (dengu)", e: "\u{1FAD8}", kcal: 269, p: 15, c: 45, f: 4, tag: ["plantpro", "carb", "ea"] },
  { n: "Cowpeas (kunde)", e: "\u{1FAD8}", kcal: 200, p: 13, c: 35, f: 1, tag: ["plantpro", "carb", "ea"] },
  { n: "Tofu", e: "⬜", kcal: 144, p: 15, c: 3, f: 9, tag: ["plantpro"] },
  /* Dairy */
  { n: "Greek yogurt", e: "\u{1F95B}", kcal: 100, p: 17, c: 6, f: 0, tag: ["dairy", "bf", "snack"] },
  { n: "Mtindi (fermented milk)", e: "\u{1F95B}", kcal: 90, p: 6, c: 9, f: 3, tag: ["dairy", "bf", "snack", "ea"] },
  /* Vegetables */
  { n: "Amaranth greens (mchicha)", e: "\u{1F96C}", kcal: 41, p: 5, c: 7, f: 0, tag: ["veg", "ea"] },
  { n: "Cassava leaves (kisamvu)", e: "\u{1F96C}", kcal: 50, p: 6, c: 8, f: 1, tag: ["veg", "ea"] },
  { n: "Sweet potato leaves (matembele)", e: "\u{1F96C}", kcal: 45, p: 4, c: 8, f: 0, tag: ["veg", "ea"] },
  { n: "Pumpkin leaves (majani ya maboga)", e: "\u{1F96C}", kcal: 40, p: 4, c: 7, f: 1, tag: ["veg", "ea"] },
  { n: "Jute mallow (mlenda)", e: "\u{1F96C}", kcal: 38, p: 5, c: 6, f: 0, tag: ["veg", "ea"] },
  { n: "Okra (bamia)", e: "\u{1F33F}", kcal: 33, p: 2, c: 7, f: 0, tag: ["veg", "ea"] },
  { n: "African eggplant (nyanya chungu)", e: "\u{1F346}", kcal: 35, p: 1, c: 8, f: 0, tag: ["veg", "ea"] },
  { n: "Pumpkin (maboga)", e: "\u{1F383}", kcal: 49, p: 2, c: 12, f: 0, tag: ["veg", "ea"] },
  { n: "Cabbage (kabichi)", e: "\u{1F96C}", kcal: 50, p: 3, c: 11, f: 0, tag: ["veg"] },
  { n: "Green beans", e: "\u{1FADB}", kcal: 44, p: 2, c: 10, f: 0, tag: ["veg"] },
  { n: "Kachumbari (tomato & onion)", e: "\u{1F957}", kcal: 45, p: 2, c: 9, f: 1, tag: ["veg", "ea"] },
  { n: "Mixed salad", e: "\u{1F957}", kcal: 80, p: 3, c: 10, f: 3, tag: ["veg"] },
  { n: "Avocado (parachichi)", e: "\u{1F951}", kcal: 160, p: 2, c: 9, f: 15, tag: ["veg", "fat", "ea"] },
  /* Fruits */
  { n: "Banana (ndizi)", e: "\u{1F34C}", kcal: 105, p: 1, c: 27, f: 0, tag: ["fruit", "ea", "snack"] },
  { n: "Mango (embe)", e: "\u{1F96D}", kcal: 99, p: 1, c: 25, f: 1, tag: ["fruit", "ea", "snack"] },
  { n: "Pineapple (nanasi)", e: "\u{1F34D}", kcal: 82, p: 1, c: 22, f: 0, tag: ["fruit", "ea", "snack"] },
  { n: "Papaya (papai)", e: "\u{1F96D}", kcal: 68, p: 1, c: 17, f: 0, tag: ["fruit", "ea", "snack"] },
  { n: "Watermelon (tikiti)", e: "\u{1F349}", kcal: 46, p: 1, c: 12, f: 0, tag: ["fruit", "ea", "snack"] },
  { n: "Orange (chungwa)", e: "\u{1F34A}", kcal: 62, p: 1, c: 15, f: 0, tag: ["fruit", "snack", "ea"] },
  { n: "Guava (mapera)", e: "\u{1F350}", kcal: 68, p: 3, c: 14, f: 1, tag: ["fruit", "snack", "ea"] },
  /* Snacks / healthy fats */
  { n: "Roasted groundnuts (karanga)", e: "\u{1F95C}", kcal: 170, p: 7, c: 6, f: 14, tag: ["snack", "fat", "ea"] },
  { n: "Cashews (korosho)", e: "\u{1F95C}", kcal: 160, p: 5, c: 9, f: 13, tag: ["snack", "fat", "ea"] },
  { n: "Almonds", e: "\u{1F330}", kcal: 164, p: 6, c: 6, f: 14, tag: ["snack", "fat"] },
  { n: "Roasted maize (mahindi)", e: "\u{1F33D}", kcal: 130, p: 4, c: 27, f: 2, tag: ["snack", "ea"] },
  { n: "Maandazi", e: "\u{1F369}", kcal: 200, p: 4, c: 30, f: 7, tag: ["snack", "ea"] }
];

// Only the fields the generator needs. The descriptive copy stays in the app.
const CONDITIONS = [
  { id: "diabetes", carbControl: true, limit: ["Maandazi", "Wali (rice)", "Mango (embe)", "Pineapple (nanasi)", "Watermelon (tikiti)"] },
  { id: "pcos", carbControl: true, limit: ["Maandazi", "Wali (rice)", "Pineapple (nanasi)", "Watermelon (tikiti)"] },
  { id: "hypertension", lowSodium: true, limit: ["Maandazi", "Chapati", "Dagaa (sardines)"] },
  { id: "ulcers", gentle: true, limit: ["Maandazi", "Chapati", "Orange (chungwa)", "Pineapple (nanasi)", "Kachumbari (tomato & onion)"] },
  { id: "cholesterol", lowSatFat: true, limit: ["Maandazi", "Chapati", "Goat meat (mbuzi)", "Nyama choma (lean beef)"] }
];

const ACT = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, athlete: 1.9 };
const HIGH_GI = /wali|white rice|ugali|maize|white bread|andazi|chapati|plantain|cassava|muhogo/i;

function hasCondition(p, flag) {
  return ((p && p.conditions) || []).some(id => {
    const c = CONDITIONS.find(x => x.id === id);
    return c && c[flag];
  });
}

function limitedFoods(p) {
  const s = {};
  ((p && p.conditions) || []).forEach(cid => {
    const c = CONDITIONS.find(x => x.id === cid);
    if (c) c.limit.forEach(n => { s[n] = 1; });
  });
  return s;
}

function allowed(food, diet) {
  if (diet === "omnivore") return true;
  if (diet === "vegetarian") return !food.tag.includes("meat");
  if (diet === "vegan") return !(food.tag.includes("meat") || food.tag.includes("egg") || food.tag.includes("dairy"));
  return true;
}

function pick(tagWanted, p, seed, exclude) {
  const lim = limitedFoods(p);
  let pool = FOODS.filter(f => f.tag.includes(tagWanted) && allowed(f, p.diet) && !lim[f.n] && f.n !== exclude);
  if (!pool.length) pool = FOODS.filter(f => f.tag.includes(tagWanted) && allowed(f, p.diet));
  if (!pool.length) return FOODS.find(f => allowed(f, p.diet));
  if (tagWanted === "carb" && hasCondition(p, "carbControl")) {
    const lowGi = pool.filter(f => !HIGH_GI.test(f.n));
    if (lowGi.length >= 2) pool = lowGi;
  }
  const fav = (p.favs || []).includes("ea");
  const ordered = fav
    ? pool.slice().sort((a, b) => (b.tag.includes("ea") ? 1 : 0) - (a.tag.includes("ea") ? 1 : 0))
    : pool;
  return ordered[seed % ordered.length];
}

function scaleItem(f, factor) {
  return {
    n: f.n, e: f.e, serv: Math.round(factor * 10) / 10,
    kcal: Math.round(f.kcal * factor), p: Math.round(f.p * factor),
    c: Math.round(f.c * factor), f: Math.round(f.f * factor)
  };
}

function buildMeal(type, target, p, seed) {
  let items = [];
  const proteinTag = (p.diet === "vegan") ? "plantpro" : (p.diet === "vegetarian" ? (seed % 2 ? "plantpro" : "egg") : "meat");
  if (type === "Breakfast") items = [pick("bf", p, seed), pick("fruit", p, seed + 1)];
  else if (type === "Snack") items = [pick("snack", p, seed)];
  else items = [pick("carb", p, seed), pick(proteinTag, p, seed + 2), pick("veg", p, seed + 1)];
  const base = items.reduce((s, f) => s + f.kcal, 0);
  let factor = target / base;
  factor = Math.max(0.5, Math.min(2.0, factor));
  const scaled = items.map(f => scaleItem(f, factor));
  const tot = scaled.reduce((s, i) => ({ kcal: s.kcal + i.kcal, p: s.p + i.p, c: s.c + i.c, f: s.f + i.f }), { kcal: 0, p: 0, c: 0, f: 0 });
  return { type, items: scaled, tot };
}

function computeTargets(p) {
  const w = Math.max(1, +p.weight || 0), h = Math.max(1, +p.height || 0), a = Math.max(1, +p.age || 0);
  const bmr = 10 * w + 6.25 * h - 5 * a + (p.sex === "male" ? 5 : -161);
  const tdee = bmr * (ACT[p.activity] || 1.375);
  let cal = tdee;
  if (p.goal === "lose") cal = tdee - 500;
  else if (p.goal === "gain") cal = tdee + 350;
  cal = Math.max(1200, Math.round(cal / 10) * 10);
  const carbControl = hasCondition(p, "carbControl");
  const proteinPerKg = (p.goal === "gain" ? 2.0 : 1.8) + (carbControl ? 0.2 : 0);
  const protein = Math.round(proteinPerKg * w);
  const fat = Math.round((cal * (carbControl ? 0.35 : 0.27)) / 9);
  const carbs = Math.max(0, Math.round((cal - protein * 4 - fat * 9) / 4));
  return { bmr: Math.max(0, Math.round(bmr)), tdee: Math.max(0, Math.round(tdee)), cal, protein, fat, carbs, carbControl };
}

function monthSeed(d) { const x = d || new Date(); return x.getFullYear() * 12 + x.getMonth(); }
function monthKey(d) { const x = d || new Date(); return x.getFullYear() + "-" + (x.getMonth() + 1); }

// Builds one day. `extraSeed` lets a customer reshuffle a single day without changing the rest.
function buildDay(p, t, dayIndex, extraSeed) {
  const m = monthSeed();
  const s = m * 53 + dayIndex * 5 + (extraSeed || 0);
  return {
    meals: [
      buildMeal("Breakfast", t.cal * 0.25, p, s),
      buildMeal("Lunch", t.cal * 0.35, p, s + 13),
      buildMeal("Dinner", t.cal * 0.30, p, s + 27),
      buildMeal("Snack", t.cal * 0.10, p, s + 41)
    ]
  };
}

function buildPlan(p, t, howManyDays) {
  const days = [];
  const n = Math.max(0, Math.min(7, howManyDays == null ? 7 : howManyDays));
  for (let d = 0; d < n; d++) days.push(buildDay(p, t, d, 0));
  return days;
}

// The paid recipe library. Kept here so it is never shipped to an unpaid client.
const RECIPES = [
  {
    id: "bean-stew",
    title: "High-protein bean stew (maharage ya nazi, light)",
    meta: "Serves 2 · 410 kcal/serv · 24g protein",
    ingredients: ["1.5 cups cooked beans (maharage)", "1/2 cup light coconut milk", "1 onion, 2 tomatoes", "2 cloves garlic + thumb of ginger", "1 tsp oil, salt, cumin", "Handful amaranth greens (mchicha) or pumpkin leaves"],
    steps: ["Sauté onion, garlic, ginger in 1 tsp oil until soft.", "Add chopped tomatoes; cook down 5 min into a thick base.", "Stir in beans and light coconut milk; simmer 10 min.", "Fold in the greens, season with cumin & salt, simmer 3 min.", "Serve with a small portion of ugali or brown rice."]
  },
  {
    id: "tilapia-mchicha",
    title: "Pan-seared tilapia with mchicha",
    meta: "Serves 2 · 380 kcal/serv · 34g protein",
    ingredients: ["2 tilapia fillets (sato)", "2 bunches amaranth greens (mchicha)", "1 onion, 1 tomato", "1 tbsp groundnut paste", "1 tsp oil, lemon, salt, pepper"],
    steps: ["Season the fillets with salt, pepper and lemon; rest 10 min.", "Sear 3 to 4 min a side in 1 tsp oil until the skin crisps; set aside.", "In the same pan soften onion and tomato.", "Add the washed mchicha and a splash of water; cover 4 min.", "Stir the groundnut paste through, then serve the fish on top."]
  },
  {
    id: "chicken-sweet-potato",
    title: "Grilled chicken with sweet potato",
    meta: "Serves 2 · 450 kcal/serv · 38g protein",
    ingredients: ["2 chicken breasts", "2 medium sweet potatoes (kiazi kitamu)", "1 tsp paprika, 1 tsp oil", "Garlic, lemon, salt", "Kachumbari to serve"],
    steps: ["Marinate the chicken in garlic, lemon, paprika and salt for 20 min.", "Boil the sweet potato 15 min until just tender, then halve.", "Grill the chicken 5 to 6 min a side until cooked through.", "Char the sweet potato cut-side down for 2 min.", "Rest the chicken 5 min, slice, and serve with kachumbari."]
  },
  {
    id: "lentil-uji",
    title: "Savoury lentil uji for steady energy",
    meta: "Serves 2 · 300 kcal/serv · 18g protein",
    ingredients: ["1/2 cup red lentils (adesi)", "1/4 cup millet flour", "1 small onion, 1 carrot", "1 tsp oil, cumin, salt", "Squeeze of lemon"],
    steps: ["Rinse the lentils and simmer in 2 cups water for 12 min.", "Whisk the millet flour into 1/2 cup cold water until smooth.", "Stir the slurry into the lentils and cook 5 min, stirring.", "Soften onion and carrot in the oil with cumin, then fold in.", "Season, finish with lemon, and serve warm."]
  }
];

module.exports = { computeTargets, buildPlan, buildDay, monthKey, RECIPES };
