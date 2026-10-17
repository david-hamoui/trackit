// server.js - TrackIt Metric Backend Server
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Body parsing with support for large image payloads (plate scans)
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Initialize SQLite database
const dbPath = path.join(dataDir, 'trackit.db');
const db = new DatabaseSync(dbPath);

// Enable WAL mode & foreign keys
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Create tables in full METRIC system
db.exec(`
  CREATE TABLE IF NOT EXISTS profile (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT DEFAULT 'David',
    age INTEGER DEFAULT 28,
    sex TEXT DEFAULT 'male',
    height_cm REAL DEFAULT 178,
    weight_kg REAL DEFAULT 78.0,
    body_fat_pct REAL DEFAULT 15.0,
    bmi REAL DEFAULT 24.6,
    lean_mass_kg REAL DEFAULT 66.3,
    activity_level TEXT DEFAULT 'moderate',
    goal_type TEXT DEFAULT 'lean_bulk',
    commitment_rate REAL DEFAULT 250, -- +250 kcal surplus for clean muscle gain
    target_calories INTEGER DEFAULT 3050,
    target_protein_g INTEGER DEFAULT 165,
    target_carbs_g INTEGER DEFAULT 430,
    target_fat_g INTEGER DEFAULT 75,
    target_sodium_mg INTEGER DEFAULT 2300,
    target_fiber_g INTEGER DEFAULT 38,
    ingredients_to_avoid TEXT DEFAULT 'cilantro, mushrooms',
    dietary_preferences TEXT DEFAULT '{"style":"high_protein_bulk","prep_time_max":25}',
    gemini_api_key TEXT DEFAULT '',
    webhook_token TEXT DEFAULT '',
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS meals (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    meal_type TEXT NOT NULL, -- breakfast, lunch, dinner, snack
    food_name TEXT NOT NULL,
    brand TEXT DEFAULT '',
    servings REAL DEFAULT 1,
    serving_unit TEXT DEFAULT 'g',
    grams REAL DEFAULT 100,
    calories REAL NOT NULL,
    protein_g REAL NOT NULL,
    carbs_g REAL NOT NULL,
    fat_g REAL NOT NULL,
    sodium_mg REAL DEFAULT 0,
    fiber_g REAL DEFAULT 0,
    sugar_g REAL DEFAULT 0,
    source TEXT DEFAULT 'manual', -- manual, ai_scan, usda, openfoodfacts, recipe
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS health_metrics (
    id TEXT PRIMARY KEY,
    date TEXT UNIQUE NOT NULL,
    weight_kg REAL,
    body_fat_pct REAL,
    bmi REAL,
    lean_mass_kg REAL,
    sleep_hours REAL,
    sleep_in_bed_hours REAL,
    synced_source TEXT DEFAULT 'shortcut',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS custom_foods (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    brand TEXT DEFAULT '',
    serving_size_desc TEXT DEFAULT '100g',
    serving_grams REAL DEFAULT 100,
    calories REAL NOT NULL,
    protein_g REAL NOT NULL,
    carbs_g REAL NOT NULL,
    fat_g REAL NOT NULL,
    sodium_mg REAL DEFAULT 0,
    fiber_g REAL DEFAULT 0,
    barcode TEXT DEFAULT '',
    is_favorite INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// Ensure default profile row exists
const existingProfile = db.prepare('SELECT id, webhook_token FROM profile WHERE id = 1').get();
if (!existingProfile) {
  const generatedToken = process.env.WEBHOOK_TOKEN || crypto.randomBytes(16).toString('hex');
  db.prepare(`
    INSERT INTO profile (id, name, age, sex, height_cm, weight_kg, body_fat_pct, goal_type, commitment_rate, ingredients_to_avoid, webhook_token)
    VALUES (1, 'David', 28, 'male', 178, 78.0, 15.0, 'lean_bulk', 250, 'cilantro, mushrooms', ?)
  `).run(generatedToken);
}

// Static files for PWA
app.use(express.static(path.join(__dirname, 'public')));

// -------------------------------------------------------------
// Pure Metric Target Calculation Engine
// -------------------------------------------------------------
function calculateTargets(profile) {
  const age = Number(profile.age) || 28;
  const sex = profile.sex || 'male';
  const height_cm = Number(profile.height_cm) || 178;
  const weight_kg = Number(profile.weight_kg) || 78.0;
  const body_fat_pct = Number(profile.body_fat_pct) || null;
  const activity_level = profile.activity_level || 'moderate';
  const goal_type = profile.goal_type || 'lean_bulk';
  const commitment_rate = Number(profile.commitment_rate) || 250;

  // BMR calculation (Metric)
  let bmr;
  let calculation_formula = 'Mifflin-St Jeor';
  let lean_mass_kg = null;

  if (body_fat_pct && body_fat_pct > 3 && body_fat_pct < 60) {
    // Katch-McArdle Formula with Smart Scale Body Fat %
    lean_mass_kg = Number((weight_kg * (1 - (body_fat_pct / 100))).toFixed(1));
    bmr = 370 + (21.6 * lean_mass_kg);
    calculation_formula = 'Katch-McArdle (Scale Body Fat)';
  } else {
    // Standard Mifflin-St Jeor (Metric)
    if (sex === 'male') {
      bmr = (10 * weight_kg) + (6.25 * height_cm) - (5 * age) + 5;
    } else {
      bmr = (10 * weight_kg) + (6.25 * height_cm) - (5 * age) - 161;
    }
    lean_mass_kg = Number((weight_kg * 0.85).toFixed(1));
  }

  // Activity multipliers
  const multipliers = {
    sedentary: 1.2,
    light: 1.375,
    moderate: 1.55,
    very_active: 1.725,
    athlete: 1.9
  };
  const multiplier = multipliers[activity_level] || 1.55;
  const tdee = Math.round(bmr * multiplier);

  let customCal = profile.custom_target_calories;
  if (!customCal && profile.dietary_preferences) {
    try {
      const dp = typeof profile.dietary_preferences === 'string' ? JSON.parse(profile.dietary_preferences) : profile.dietary_preferences;
      if (dp && dp.custom_target_calories) customCal = dp.custom_target_calories;
    } catch (e) {}
  }

  // Target calories based on commitment surplus/deficit or custom override
  let target_calories = tdee + commitment_rate;
  if (customCal && Number(customCal) >= 1200) {
    target_calories = Math.round(Number(customCal));
    calculation_formula = 'Custom Target (' + target_calories + ' kcal)';
  } else {
    const floor = sex === 'male' ? 1600 : 1300;
    if (target_calories < floor) target_calories = floor;
  }

  // Macro distribution optimized for muscle gain / hypertrophy:
  // Protein: 2.1g per kg body weight (high protein synthesis ceiling)
  let target_protein_g = Math.round(weight_kg * 2.1);
  // Fat: 0.95g per kg body weight (optimal testosterone and hormone synthesis)
  let target_fat_g = Math.round(weight_kg * 0.95);

  // Remaining calories allocated to carbohydrates to fuel lifting sessions
  const calsFromProteinAndFat = (target_protein_g * 4) + (target_fat_g * 9);
  let remainingCals = target_calories - calsFromProteinAndFat;
  if (remainingCals < 300) {
    target_fat_g = Math.max(50, Math.round(weight_kg * 0.8));
    remainingCals = target_calories - ((target_protein_g * 4) + (target_fat_g * 9));
  }
  let target_carbs_g = Math.max(60, Math.round(remainingCals / 4));

  // Balanced target calories derived from sum of macros
  target_calories = (target_protein_g * 4) + (target_carbs_g * 4) + (target_fat_g * 9);

  const target_sodium_mg = 2300;
  const target_fiber_g = Math.round((target_calories / 1000) * 13);
  const bmi = Number((weight_kg / Math.pow(height_cm / 100, 2)).toFixed(1));

  return {
    bmr: Math.round(bmr),
    tdee,
    bmi,
    calculation_formula,
    lean_mass_kg,
    target_calories,
    target_protein_g,
    target_carbs_g,
    target_fat_g,
    target_sodium_mg,
    target_fiber_g
  };
}

// -------------------------------------------------------------
// Security & API Endpoints
// -------------------------------------------------------------

// PIN Verification Endpoint
app.all('/api/auth/verify', (req, res) => {
  const requiredPin = process.env.APP_PIN ? String(process.env.APP_PIN).trim() : '';
  if (!requiredPin) {
    return res.json({ success: true, valid: true, required: false });
  }
  const pin = (req.body && req.body.pin) || req.headers['x-app-pin'] || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '') || req.query.pin || '';
  if (String(pin).trim() === requiredPin) {
    return res.json({ success: true, valid: true, required: true });
  }
  return res.status(401).json({ success: false, valid: false, error: 'INVALID_PIN' });
});

// PIN Middleware (Excludes /api/health/sync which uses WEBHOOK_TOKEN)
app.use('/api', (req, res, next) => {
  if (req.path === '/health/sync' || req.path === '/auth/verify') {
    return next();
  }
  const requiredPin = process.env.APP_PIN ? String(process.env.APP_PIN).trim() : '';
  if (requiredPin) {
    const pin = req.headers['x-app-pin'] || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '') || req.query.pin || '';
    if (String(pin).trim() !== requiredPin) {
      return res.status(401).json({ error: 'PIN_REQUIRED', message: 'Passcode required' });
    }
  }
  next();
});

// 1. GET /api/profile
app.get('/api/profile', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM profile WHERE id = 1').get();
    if (!row) return res.status(404).json({ error: 'Profile not found' });
    const targets = calculateTargets(row);
    // Never expose raw api key unless explicitly asked, or pass securely
    const activeWebhookToken = process.env.WEBHOOK_TOKEN || row.webhook_token;
    const safeRow = { ...row };
    delete safeRow.gemini_api_key;
    res.json({
      ...safeRow,
      ...targets,
      webhook_token: activeWebhookToken,
      has_gemini_key: Boolean(process.env.GEMINI_API_KEY || row.gemini_api_key)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. POST /api/profile
app.post('/api/profile', (req, res) => {
  try {
    const p = req.body;
    const current = db.prepare('SELECT * FROM profile WHERE id = 1').get() || {};
    const merged = { ...current, ...p };
    const targets = calculateTargets(merged);

    db.prepare(`
      UPDATE profile SET
        name = ?, age = ?, sex = ?, height_cm = ?, weight_kg = ?, body_fat_pct = ?,
        bmi = ?, lean_mass_kg = ?, activity_level = ?, goal_type = ?, commitment_rate = ?,
        target_calories = ?, target_protein_g = ?, target_carbs_g = ?, target_fat_g = ?,
        target_sodium_mg = ?, target_fiber_g = ?,
        ingredients_to_avoid = ?, dietary_preferences = ?,
        gemini_api_key = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `).run(
      merged.name || 'David',
      Number(merged.age) || 28,
      merged.sex || 'male',
      Number(merged.height_cm) || 178,
      Number(merged.weight_kg) || 78.0,
      merged.body_fat_pct !== undefined ? Number(merged.body_fat_pct) : 15.0,
      targets.bmi,
      targets.lean_mass_kg,
      merged.activity_level || 'moderate',
      merged.goal_type || 'lean_bulk',
      Number(merged.commitment_rate) !== undefined ? Number(merged.commitment_rate) : 250,
      targets.target_calories,
      targets.target_protein_g,
      targets.target_carbs_g,
      targets.target_fat_g,
      targets.target_sodium_mg,
      targets.target_fiber_g,
      merged.ingredients_to_avoid !== undefined ? merged.ingredients_to_avoid : current.ingredients_to_avoid || 'cilantro, mushrooms',
      typeof merged.dietary_preferences === 'string' ? merged.dietary_preferences : JSON.stringify(merged.dietary_preferences || {}),
      (merged.gemini_api_key !== undefined && merged.gemini_api_key.trim() !== '') ? merged.gemini_api_key.trim() : (current.gemini_api_key || '')
    );

    const updated = db.prepare('SELECT * FROM profile WHERE id = 1').get();
    const safeUpdated = { ...updated };
    delete safeUpdated.gemini_api_key;
    res.json({ ...safeUpdated, ...targets, webhook_token: process.env.WEBHOOK_TOKEN || updated.webhook_token, has_gemini_key: Boolean(process.env.GEMINI_API_KEY || updated.gemini_api_key) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. GET /api/meals?date=YYYY-MM-DD
app.get('/api/meals', (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const meals = db.prepare('SELECT * FROM meals WHERE date = ? ORDER BY created_at ASC').all(date);

    const totals = meals.reduce((acc, m) => {
      acc.calories += m.calories;
      acc.protein_g += m.protein_g;
      acc.carbs_g += m.carbs_g;
      acc.fat_g += m.fat_g;
      acc.sodium_mg += m.sodium_mg || 0;
      acc.fiber_g += m.fiber_g || 0;
      acc.sugar_g += m.sugar_g || 0;
      return acc;
    }, { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, sodium_mg: 0, fiber_g: 0, sugar_g: 0 });

    Object.keys(totals).forEach(k => {
      totals[k] = Math.round(totals[k] * 10) / 10;
    });

    const health = db.prepare('SELECT * FROM health_metrics WHERE date = ?').get(date) || null;

    res.json({ date, meals, totals, health });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. POST /api/meals
app.post('/api/meals', (req, res) => {
  try {
    const items = Array.isArray(req.body) ? req.body : [req.body];
    const inserted = [];

    const insertStmt = db.prepare(`
      INSERT INTO meals (
        id, date, meal_type, food_name, brand, servings, serving_unit, grams,
        calories, protein_g, carbs_g, fat_g, sodium_mg, fiber_g, sugar_g, source, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of items) {
      const id = item.id || crypto.randomUUID();
      const date = item.date || new Date().toISOString().split('T')[0];
      const meal_type = item.meal_type || 'snack';
      const food_name = item.food_name || 'Food Item';
      const brand = item.brand || '';
      const servings = Number(item.servings) || 1;
      const serving_unit = item.serving_unit || 'g';
      const grams = Number(item.grams) || 100;
      const calories = Math.round(Number(item.calories) || 0);
      const protein_g = Math.round((Number(item.protein_g) || 0) * 10) / 10;
      const carbs_g = Math.round((Number(item.carbs_g) || 0) * 10) / 10;
      const fat_g = Math.round((Number(item.fat_g) || 0) * 10) / 10;
      const sodium_mg = Math.round(Number(item.sodium_mg) || 0);
      const fiber_g = Math.round((Number(item.fiber_g) || 0) * 10) / 10;
      const sugar_g = Math.round((Number(item.sugar_g) || 0) * 10) / 10;
      const source = item.source || 'manual';
      const notes = item.notes || '';

      insertStmt.run(
        id, date, meal_type, food_name, brand, servings, serving_unit, grams,
        calories, protein_g, carbs_g, fat_g, sodium_mg, fiber_g, sugar_g, source, notes
      );
      inserted.push({ id, date, meal_type, food_name, calories, protein_g, carbs_g, fat_g });
    }

    res.status(201).json({ success: true, count: inserted.length, meals: inserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. DELETE /api/meals/:id
app.delete('/api/meals/:id', (req, res) => {
  try {
    const { id } = req.params;
    db.prepare('DELETE FROM meals WHERE id = ?').run(id);
    res.json({ success: true, deletedId: id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Food Search (Comprehensive USDA Staples + D1/SQLite Custom Foods + AI Nutritionist Fallback)
const BUILT_IN_FOODS = [
  // Steaks & Beef Cuts
  { name: 'Sirloin Steak (Beef, Lean, Grilled)', brand: 'USDA', serving_grams: 100, calories: 183, protein_g: 30.3, carbs_g: 0, fat_g: 6.1, sodium_mg: 54, fiber_g: 0 },
  { name: 'Ribeye Steak (Beef, Cooked)', brand: 'USDA', serving_grams: 100, calories: 248, protein_g: 26.5, carbs_g: 0, fat_g: 15.1, sodium_mg: 63, fiber_g: 0 },
  { name: 'New York Strip Steak (Beef, Grilled)', brand: 'USDA', serving_grams: 100, calories: 217, protein_g: 27.8, carbs_g: 0, fat_g: 11.2, sodium_mg: 58, fiber_g: 0 },
  { name: 'Filet Mignon / Tenderloin Steak (Beef, Grilled)', brand: 'USDA', serving_grams: 100, calories: 218, protein_g: 28.2, carbs_g: 0, fat_g: 11.0, sodium_mg: 56, fiber_g: 0 },
  { name: 'Flank Steak (Beef, Grilled)', brand: 'USDA', serving_grams: 100, calories: 192, protein_g: 27.6, carbs_g: 0, fat_g: 8.4, sodium_mg: 59, fiber_g: 0 },
  { name: 'T-Bone Steak (Beef, Grilled)', brand: 'USDA', serving_grams: 100, calories: 247, protein_g: 24.6, carbs_g: 0, fat_g: 16.0, sodium_mg: 60, fiber_g: 0 },
  { name: 'Skirt Steak (Beef, Grilled)', brand: 'USDA', serving_grams: 100, calories: 205, protein_g: 26.0, carbs_g: 0, fat_g: 10.5, sodium_mg: 65, fiber_g: 0 },
  { name: 'Rump Steak (Beef, Grilled)', brand: 'USDA', serving_grams: 100, calories: 175, protein_g: 29.0, carbs_g: 0, fat_g: 5.8, sodium_mg: 55, fiber_g: 0 },
  { name: 'Flat Iron Steak (Beef, Grilled)', brand: 'USDA', serving_grams: 100, calories: 180, protein_g: 27.0, carbs_g: 0, fat_g: 7.5, sodium_mg: 57, fiber_g: 0 },
  { name: 'Minute Steak / Sandwich Steak (Beef)', brand: 'USDA', serving_grams: 100, calories: 170, protein_g: 28.0, carbs_g: 0, fat_g: 5.5, sodium_mg: 60, fiber_g: 0 },
  { name: 'Beef Chuck Roast (Cooked)', brand: 'USDA', serving_grams: 100, calories: 210, protein_g: 26.0, carbs_g: 0, fat_g: 11.0, sodium_mg: 60, fiber_g: 0 },
  { name: 'Beef Brisket (Cooked/Smoked)', brand: 'USDA', serving_grams: 100, calories: 240, protein_g: 24.0, carbs_g: 0, fat_g: 15.0, sodium_mg: 65, fiber_g: 0 },
  { name: 'Extra Lean Ground Beef (95/5)', brand: 'USDA', serving_grams: 100, calories: 164, protein_g: 25.7, carbs_g: 0, fat_g: 6.1, sodium_mg: 60, fiber_g: 0 },
  { name: 'Lean Ground Beef (90/10)', brand: 'USDA', serving_grams: 100, calories: 176, protein_g: 26.0, carbs_g: 0, fat_g: 10.0, sodium_mg: 66, fiber_g: 0 },
  { name: 'Ground Beef (85/15)', brand: 'USDA', serving_grams: 100, calories: 215, protein_g: 24.5, carbs_g: 0, fat_g: 12.5, sodium_mg: 70, fiber_g: 0 },
  { name: 'Ground Beef (80/20)', brand: 'USDA', serving_grams: 100, calories: 254, protein_g: 22.8, carbs_g: 0, fat_g: 17.5, sodium_mg: 74, fiber_g: 0 },
  { name: 'Beef Burger Patty (Cooked)', brand: 'USDA', serving_grams: 100, calories: 240, protein_g: 24.0, carbs_g: 0, fat_g: 15.0, sodium_mg: 70, fiber_g: 0 },

  // Poultry
  { name: 'Chicken Breast (Cooked, Skinless, Grilled)', brand: 'USDA', serving_grams: 100, calories: 165, protein_g: 31.0, carbs_g: 0, fat_g: 3.6, sodium_mg: 74, fiber_g: 0 },
  { name: 'Chicken Thigh (Skinless, Boneless, Cooked)', brand: 'USDA', serving_grams: 100, calories: 209, protein_g: 26.0, carbs_g: 0, fat_g: 10.9, sodium_mg: 84, fiber_g: 0 },
  { name: 'Chicken Tenderloin (Grilled)', brand: 'USDA', serving_grams: 100, calories: 150, protein_g: 32.0, carbs_g: 0, fat_g: 2.0, sodium_mg: 70, fiber_g: 0 },
  { name: 'Chicken Wings (Cooked, Meat & Skin)', brand: 'USDA', serving_grams: 100, calories: 290, protein_g: 27.0, carbs_g: 0, fat_g: 19.5, sodium_mg: 82, fiber_g: 0 },
  { name: 'Ground Chicken (92% Lean, Cooked)', brand: 'USDA', serving_grams: 100, calories: 190, protein_g: 24.0, carbs_g: 0, fat_g: 10.0, sodium_mg: 80, fiber_g: 0 },
  { name: 'Ground Turkey (99% Lean, Cooked)', brand: 'USDA', serving_grams: 100, calories: 138, protein_g: 29.5, carbs_g: 0, fat_g: 1.5, sodium_mg: 72, fiber_g: 0 },
  { name: 'Ground Turkey (93/7, Cooked)', brand: 'USDA', serving_grams: 100, calories: 182, protein_g: 24.0, carbs_g: 0, fat_g: 9.5, sodium_mg: 78, fiber_g: 0 },
  { name: 'Turkey Breast (Roasted, Skinless)', brand: 'USDA', serving_grams: 100, calories: 135, protein_g: 30.0, carbs_g: 0, fat_g: 1.0, sodium_mg: 50, fiber_g: 0 },
  { name: 'Deli Turkey Breast (Sliced)', brand: 'USDA', serving_grams: 100, calories: 104, protein_g: 18.0, carbs_g: 3.0, fat_g: 1.5, sodium_mg: 850, fiber_g: 0 },
  { name: 'Pork Tenderloin (Roasted, Lean)', brand: 'USDA', serving_grams: 100, calories: 143, protein_g: 26.0, carbs_g: 0, fat_g: 3.5, sodium_mg: 55, fiber_g: 0 },
  { name: 'Pork Loin Chop (Center Cut, Grilled)', brand: 'USDA', serving_grams: 100, calories: 187, protein_g: 28.0, carbs_g: 0, fat_g: 7.5, sodium_mg: 60, fiber_g: 0 },
  { name: 'Bacon (Pork, Cooked Crisp)', brand: 'USDA', serving_grams: 100, calories: 541, protein_g: 37.0, carbs_g: 1.4, fat_g: 41.8, sodium_mg: 1717, fiber_g: 0 },
  { name: 'Lamb Chops (Cooked, Lean)', brand: 'USDA', serving_grams: 100, calories: 215, protein_g: 26.0, carbs_g: 0, fat_g: 12.0, sodium_mg: 70, fiber_g: 0 },
  { name: 'Ground Lamb (Cooked)', brand: 'USDA', serving_grams: 100, calories: 280, protein_g: 25.0, carbs_g: 0, fat_g: 19.0, sodium_mg: 75, fiber_g: 0 },
  { name: 'Bison / Buffalo (Ground, Cooked)', brand: 'USDA', serving_grams: 100, calories: 179, protein_g: 26.5, carbs_g: 0, fat_g: 7.5, sodium_mg: 65, fiber_g: 0 },

  // Fish & Seafood
  { name: 'Atlantic Salmon (Baked/Pan-Seared)', brand: 'USDA', serving_grams: 100, calories: 206, protein_g: 22.1, carbs_g: 0, fat_g: 12.3, sodium_mg: 61, fiber_g: 0 },
  { name: 'Wild Sockeye Salmon (Baked)', brand: 'USDA', serving_grams: 100, calories: 169, protein_g: 24.6, carbs_g: 0, fat_g: 7.0, sodium_mg: 65, fiber_g: 0 },
  { name: 'Smoked Salmon (Lox)', brand: 'USDA', serving_grams: 100, calories: 117, protein_g: 18.3, carbs_g: 0, fat_g: 4.3, sodium_mg: 784, fiber_g: 0 },
  { name: 'Canned Tuna (in Water, Drained)', brand: 'USDA', serving_grams: 100, calories: 116, protein_g: 25.5, carbs_g: 0, fat_g: 0.8, sodium_mg: 333, fiber_g: 0 },
  { name: 'Canned Tuna (in Olive Oil, Drained)', brand: 'USDA', serving_grams: 100, calories: 198, protein_g: 29.0, carbs_g: 0, fat_g: 8.2, sodium_mg: 350, fiber_g: 0 },
  { name: 'Yellowfin Tuna (Fresh, Cooked)', brand: 'USDA', serving_grams: 100, calories: 130, protein_g: 29.0, carbs_g: 0, fat_g: 0.6, sodium_mg: 45, fiber_g: 0 },
  { name: 'Atlantic Cod (Baked)', brand: 'USDA', serving_grams: 100, calories: 105, protein_g: 22.8, carbs_g: 0, fat_g: 0.9, sodium_mg: 86, fiber_g: 0 },
  { name: 'Tilapia (Baked)', brand: 'USDA', serving_grams: 100, calories: 128, protein_g: 26.1, carbs_g: 0, fat_g: 2.7, sodium_mg: 56, fiber_g: 0 },
  { name: 'Halibut (Cooked)', brand: 'USDA', serving_grams: 100, calories: 140, protein_g: 27.0, carbs_g: 0, fat_g: 3.0, sodium_mg: 68, fiber_g: 0 },
  { name: 'Shrimp / Prawns (Steamed/Grilled)', brand: 'USDA', serving_grams: 100, calories: 99, protein_g: 24.0, carbs_g: 0.2, fat_g: 0.3, sodium_mg: 111, fiber_g: 0 },
  { name: 'Scallops (Steamed/Pan-Seared)', brand: 'USDA', serving_grams: 100, calories: 111, protein_g: 20.5, carbs_g: 5.4, fat_g: 0.8, sodium_mg: 160, fiber_g: 0 },

  // Eggs & Dairy
  { name: 'Eggs (Whole, Large)', brand: 'USDA', serving_grams: 100, calories: 143, protein_g: 12.6, carbs_g: 0.7, fat_g: 9.5, sodium_mg: 142, fiber_g: 0 },
  { name: 'Egg Whites (Liquid/Cooked)', brand: 'USDA', serving_grams: 100, calories: 52, protein_g: 10.9, carbs_g: 0.7, fat_g: 0.2, sodium_mg: 166, fiber_g: 0 },
  { name: 'Greek Yogurt (0% Fat, Plain)', brand: 'Fage', serving_grams: 100, calories: 59, protein_g: 10.3, carbs_g: 3.6, fat_g: 0.4, sodium_mg: 36, fiber_g: 0 },
  { name: 'Greek Yogurt (2% Fat, Plain)', brand: 'Fage', serving_grams: 100, calories: 73, protein_g: 9.9, carbs_g: 3.9, fat_g: 2.0, sodium_mg: 38, fiber_g: 0 },
  { name: 'Greek Yogurt (5% Whole Milk, Plain)', brand: 'Fage', serving_grams: 100, calories: 97, protein_g: 9.0, carbs_g: 3.8, fat_g: 5.0, sodium_mg: 40, fiber_g: 0 },
  { name: 'Skyr (Icelandic Yogurt, 0% Fat)', brand: 'Siggi\'s', serving_grams: 100, calories: 63, protein_g: 11.0, carbs_g: 4.0, fat_g: 0.2, sodium_mg: 40, fiber_g: 0 },
  { name: 'Cottage Cheese (1% Low Fat)', brand: 'USDA', serving_grams: 100, calories: 72, protein_g: 12.4, carbs_g: 2.7, fat_g: 1.0, sodium_mg: 406, fiber_g: 0 },
  { name: 'Cottage Cheese (2% Low Fat)', brand: 'USDA', serving_grams: 100, calories: 86, protein_g: 11.8, carbs_g: 3.0, fat_g: 2.5, sodium_mg: 380, fiber_g: 0 },
  { name: 'Cottage Cheese (4% Whole Milk)', brand: 'USDA', serving_grams: 100, calories: 98, protein_g: 11.1, carbs_g: 3.4, fat_g: 4.3, sodium_mg: 364, fiber_g: 0 },
  { name: 'Cheddar Cheese (Sharp)', brand: 'USDA', serving_grams: 100, calories: 403, protein_g: 25.0, carbs_g: 1.3, fat_g: 33.1, sodium_mg: 621, fiber_g: 0 },
  { name: 'Mozzarella (Part-Skim)', brand: 'USDA', serving_grams: 100, calories: 280, protein_g: 28.0, carbs_g: 3.1, fat_g: 17.1, sodium_mg: 627, fiber_g: 0 },
  { name: 'Parmesan Cheese (Grated)', brand: 'USDA', serving_grams: 100, calories: 431, protein_g: 38.5, carbs_g: 4.1, fat_g: 28.6, sodium_mg: 1529, fiber_g: 0 },
  { name: 'Feta Cheese', brand: 'USDA', serving_grams: 100, calories: 264, protein_g: 14.2, carbs_g: 4.1, fat_g: 21.3, sodium_mg: 1116, fiber_g: 0 },
  { name: 'Skim Milk (Fat Free)', brand: 'USDA', serving_grams: 100, calories: 35, protein_g: 3.4, carbs_g: 5.0, fat_g: 0.1, sodium_mg: 44, fiber_g: 0 },
  { name: '1% Low Fat Milk', brand: 'USDA', serving_grams: 100, calories: 42, protein_g: 3.4, carbs_g: 5.0, fat_g: 1.0, sodium_mg: 44, fiber_g: 0 },
  { name: '2% Reduced Fat Milk', brand: 'USDA', serving_grams: 100, calories: 50, protein_g: 3.3, carbs_g: 4.8, fat_g: 2.0, sodium_mg: 43, fiber_g: 0 },
  { name: 'Whole Milk (3.25%)', brand: 'USDA', serving_grams: 100, calories: 61, protein_g: 3.2, carbs_g: 4.8, fat_g: 3.3, sodium_mg: 43, fiber_g: 0 },
  { name: 'Unsweetened Almond Milk', brand: 'Silk', serving_grams: 100, calories: 15, protein_g: 0.6, carbs_g: 0.3, fat_g: 1.2, sodium_mg: 65, fiber_g: 0.5 },
  { name: 'Oat Milk (Unsweetened)', brand: 'Oatly', serving_grams: 100, calories: 45, protein_g: 1.2, carbs_g: 7.5, fat_g: 1.5, sodium_mg: 40, fiber_g: 0.8 },
  { name: 'Soy Milk (Unsweetened)', brand: 'Silk', serving_grams: 100, calories: 43, protein_g: 3.8, carbs_g: 2.0, fat_g: 2.1, sodium_mg: 50, fiber_g: 1.0 },

  // Protein Powders & Supplements
  { name: 'Whey Protein Isolate (100%)', brand: 'Gold Standard', serving_grams: 30, calories: 115, protein_g: 27.0, carbs_g: 1.0, fat_g: 0.3, sodium_mg: 80, fiber_g: 0 },
  { name: 'Whey Protein Concentrate', brand: 'Gold Standard', serving_grams: 30, calories: 125, protein_g: 24.0, carbs_g: 2.5, fat_g: 2.0, sodium_mg: 110, fiber_g: 0 },
  { name: 'Casein Protein Powder', brand: 'Optimum Nutrition', serving_grams: 30, calories: 120, protein_g: 24.0, carbs_g: 3.0, fat_g: 1.0, sodium_mg: 140, fiber_g: 0 },
  { name: 'Plant Protein Powder (Pea/Rice)', brand: 'Orgain', serving_grams: 30, calories: 120, protein_g: 21.0, carbs_g: 4.0, fat_g: 2.0, sodium_mg: 180, fiber_g: 1.5 },
  { name: 'Protein Bar (Generic 20g High Protein)', brand: 'Quest / Barebells', serving_grams: 60, calories: 200, protein_g: 20.0, carbs_g: 22.0, fat_g: 7.0, sodium_mg: 200, fiber_g: 14.0 },

  // Grains, Potatoes & Carbs
  { name: 'White Rice (Cooked, Jasmine)', brand: 'USDA', serving_grams: 100, calories: 130, protein_g: 2.7, carbs_g: 28.2, fat_g: 0.3, sodium_mg: 1, fiber_g: 0.4 },
  { name: 'Basmati Rice (Cooked)', brand: 'USDA', serving_grams: 100, calories: 121, protein_g: 3.5, carbs_g: 25.2, fat_g: 0.4, sodium_mg: 1, fiber_g: 0.4 },
  { name: 'Brown Rice (Cooked)', brand: 'USDA', serving_grams: 100, calories: 123, protein_g: 2.7, carbs_g: 25.6, fat_g: 1.0, sodium_mg: 4, fiber_g: 1.6 },
  { name: 'Rolled Oats (Dry)', brand: 'Quaker', serving_grams: 100, calories: 379, protein_g: 13.2, carbs_g: 67.7, fat_g: 6.9, sodium_mg: 2, fiber_g: 10.6 },
  { name: 'Cream of Rice (Dry)', brand: 'Nabisco', serving_grams: 100, calories: 367, protein_g: 7.0, carbs_g: 82.0, fat_g: 0.5, sodium_mg: 0, fiber_g: 1.5 },
  { name: 'Sweet Potato (Baked, Flesh Only)', brand: 'USDA', serving_grams: 100, calories: 90, protein_g: 2.0, carbs_g: 20.7, fat_g: 0.2, sodium_mg: 36, fiber_g: 3.3 },
  { name: 'Russet Potato (Boiled/Baked)', brand: 'USDA', serving_grams: 100, calories: 87, protein_g: 1.9, carbs_g: 20.0, fat_g: 0.1, sodium_mg: 6, fiber_g: 1.8 },
  { name: 'Red Potato (Boiled/Baked)', brand: 'USDA', serving_grams: 100, calories: 89, protein_g: 2.3, carbs_g: 20.0, fat_g: 0.2, sodium_mg: 7, fiber_g: 1.8 },
  { name: 'White Pasta / Spaghetti (Cooked)', brand: 'Barilla', serving_grams: 100, calories: 158, protein_g: 5.8, carbs_g: 30.9, fat_g: 0.9, sodium_mg: 1, fiber_g: 1.8 },
  { name: 'Whole Wheat Pasta (Cooked)', brand: 'Barilla', serving_grams: 100, calories: 149, protein_g: 6.0, carbs_g: 30.0, fat_g: 1.1, sodium_mg: 2, fiber_g: 3.9 },
  { name: 'Whole Wheat Bread', brand: 'USDA', serving_grams: 100, calories: 247, protein_g: 13.0, carbs_g: 41.3, fat_g: 3.4, sodium_mg: 400, fiber_g: 6.8 },
  { name: 'Sourdough Bread', brand: 'Bakery', serving_grams: 100, calories: 260, protein_g: 10.0, carbs_g: 50.0, fat_g: 1.5, sodium_mg: 480, fiber_g: 2.2 },
  { name: 'White Bread (Sliced)', brand: 'Bakery', serving_grams: 100, calories: 265, protein_g: 9.0, carbs_g: 49.0, fat_g: 3.2, sodium_mg: 490, fiber_g: 2.7 },
  { name: 'Plain Bagel', brand: 'Bakery', serving_grams: 100, calories: 257, protein_g: 10.2, carbs_g: 49.3, fat_g: 1.5, sodium_mg: 439, fiber_g: 2.3 },
  { name: 'English Muffin', brand: 'Bakery', serving_grams: 100, calories: 235, protein_g: 8.5, carbs_g: 45.0, fat_g: 1.8, sodium_mg: 410, fiber_g: 2.5 },
  { name: 'Flour Tortilla', brand: 'Mission', serving_grams: 100, calories: 304, protein_g: 8.0, carbs_g: 50.0, fat_g: 7.8, sodium_mg: 580, fiber_g: 2.8 },
  { name: 'Corn Tortilla', brand: 'Mission', serving_grams: 100, calories: 218, protein_g: 5.7, carbs_g: 45.0, fat_g: 2.8, sodium_mg: 45, fiber_g: 6.0 },
  { name: 'Rice Cakes (Plain)', brand: 'Quaker', serving_grams: 100, calories: 387, protein_g: 8.0, carbs_g: 82.0, fat_g: 2.8, sodium_mg: 20, fiber_g: 4.0 },
  { name: 'Quinoa (Cooked)', brand: 'USDA', serving_grams: 100, calories: 120, protein_g: 4.4, carbs_g: 21.3, fat_g: 1.9, sodium_mg: 7, fiber_g: 2.8 },

  // Fats & Oils
  { name: 'Olive Oil (Extra Virgin)', brand: 'USDA', serving_grams: 14, calories: 119, protein_g: 0, carbs_g: 0, fat_g: 13.5, sodium_mg: 0, fiber_g: 0 },
  { name: 'Avocado Oil', brand: 'USDA', serving_grams: 14, calories: 124, protein_g: 0, carbs_g: 0, fat_g: 14.0, sodium_mg: 0, fiber_g: 0 },
  { name: 'Pure Butter', brand: 'Land O Lakes', serving_grams: 14, calories: 102, protein_g: 0.1, carbs_g: 0, fat_g: 11.5, sodium_mg: 90, fiber_g: 0 },
  { name: 'Ghee (Clarified Butter)', brand: 'USDA', serving_grams: 14, calories: 123, protein_g: 0, carbs_g: 0, fat_g: 13.9, sodium_mg: 0, fiber_g: 0 },
  { name: 'Avocado (Fresh)', brand: 'Fresh', serving_grams: 100, calories: 160, protein_g: 2.0, carbs_g: 8.5, fat_g: 14.7, sodium_mg: 7, fiber_g: 6.7 },
  { name: 'Natural Peanut Butter', brand: 'Smuckers', serving_grams: 32, calories: 190, protein_g: 8.0, carbs_g: 7.0, fat_g: 16.0, sodium_mg: 105, fiber_g: 3.0 },
  { name: 'Almond Butter (Natural)', brand: 'Justin\'s', serving_grams: 32, calories: 196, protein_g: 6.7, carbs_g: 6.0, fat_g: 17.8, sodium_mg: 3, fiber_g: 3.3 },
  { name: 'Raw Almonds', brand: 'USDA', serving_grams: 100, calories: 579, protein_g: 21.2, carbs_g: 21.6, fat_g: 49.9, sodium_mg: 1, fiber_g: 12.5 },
  { name: 'Raw Walnuts', brand: 'USDA', serving_grams: 100, calories: 654, protein_g: 15.2, carbs_g: 13.7, fat_g: 65.2, sodium_mg: 2, fiber_g: 6.7 },
  { name: 'Raw Cashews', brand: 'USDA', serving_grams: 100, calories: 553, protein_g: 18.2, carbs_g: 30.2, fat_g: 43.8, sodium_mg: 12, fiber_g: 3.3 },
  { name: 'Chia Seeds', brand: 'USDA', serving_grams: 100, calories: 486, protein_g: 16.5, carbs_g: 42.1, fat_g: 30.7, sodium_mg: 16, fiber_g: 34.4 },
  { name: 'Pumpkin Seeds (Pepitas)', brand: 'USDA', serving_grams: 100, calories: 559, protein_g: 30.2, carbs_g: 10.7, fat_g: 49.1, sodium_mg: 7, fiber_g: 6.0 },

  // Fruits & Vegetables
  { name: 'Banana (Fresh)', brand: 'Fresh', serving_grams: 100, calories: 89, protein_g: 1.1, carbs_g: 22.8, fat_g: 0.3, sodium_mg: 1, fiber_g: 2.6 },
  { name: 'Apple (Fresh)', brand: 'Fresh', serving_grams: 100, calories: 52, protein_g: 0.3, carbs_g: 13.8, fat_g: 0.2, sodium_mg: 1, fiber_g: 2.4 },
  { name: 'Blueberries (Fresh)', brand: 'Fresh', serving_grams: 100, calories: 57, protein_g: 0.7, carbs_g: 14.5, fat_g: 0.3, sodium_mg: 1, fiber_g: 2.4 },
  { name: 'Strawberries (Fresh)', brand: 'Fresh', serving_grams: 100, calories: 32, protein_g: 0.7, carbs_g: 7.7, fat_g: 0.3, sodium_mg: 1, fiber_g: 2.0 },
  { name: 'Raspberries (Fresh)', brand: 'Fresh', serving_grams: 100, calories: 52, protein_g: 1.2, carbs_g: 11.9, fat_g: 0.7, sodium_mg: 1, fiber_g: 6.5 },
  { name: 'Orange (Fresh)', brand: 'Fresh', serving_grams: 100, calories: 47, protein_g: 0.9, carbs_g: 11.8, fat_g: 0.1, sodium_mg: 0, fiber_g: 2.4 },
  { name: 'Watermelon (Fresh)', brand: 'Fresh', serving_grams: 100, calories: 30, protein_g: 0.6, carbs_g: 7.6, fat_g: 0.2, sodium_mg: 1, fiber_g: 0.4 },
  { name: 'Broccoli (Steamed)', brand: 'USDA', serving_grams: 100, calories: 35, protein_g: 2.4, carbs_g: 7.2, fat_g: 0.4, sodium_mg: 41, fiber_g: 3.3 },
  { name: 'Spinach (Fresh/Raw)', brand: 'USDA', serving_grams: 100, calories: 23, protein_g: 2.9, carbs_g: 3.6, fat_g: 0.4, sodium_mg: 79, fiber_g: 2.2 },
  { name: 'Asparagus (Cooked)', brand: 'USDA', serving_grams: 100, calories: 22, protein_g: 2.4, carbs_g: 4.1, fat_g: 0.2, sodium_mg: 14, fiber_g: 2.0 },
  { name: 'Green Beans (Steamed)', brand: 'USDA', serving_grams: 100, calories: 35, protein_g: 1.9, carbs_g: 7.9, fat_g: 0.3, sodium_mg: 6, fiber_g: 3.2 },
  { name: 'White Mushrooms', brand: 'Fresh', serving_grams: 100, calories: 22, protein_g: 3.1, carbs_g: 3.3, fat_g: 0.3, sodium_mg: 5, fiber_g: 1.0 },
  { name: 'Zucchini (Cooked)', brand: 'Fresh', serving_grams: 100, calories: 17, protein_g: 1.2, carbs_g: 3.1, fat_g: 0.3, sodium_mg: 8, fiber_g: 1.0 },
  { name: 'Bell Pepper (Red/Green)', brand: 'Fresh', serving_grams: 100, calories: 31, protein_g: 1.0, carbs_g: 6.0, fat_g: 0.3, sodium_mg: 4, fiber_g: 2.1 },
  { name: 'Carrots (Fresh/Raw)', brand: 'Fresh', serving_grams: 100, calories: 41, protein_g: 0.9, carbs_g: 9.6, fat_g: 0.2, sodium_mg: 69, fiber_g: 2.8 },
  { name: 'Tomato (Fresh)', brand: 'Fresh', serving_grams: 100, calories: 18, protein_g: 0.9, carbs_g: 3.9, fat_g: 0.2, sodium_mg: 5, fiber_g: 1.2 },
  { name: 'Cucumber (Fresh)', brand: 'Fresh', serving_grams: 100, calories: 15, protein_g: 0.7, carbs_g: 3.6, fat_g: 0.1, sodium_mg: 2, fiber_g: 0.5 },

  // Plant Proteins & Legumes
  { name: 'Firm Tofu', brand: 'USDA', serving_grams: 100, calories: 144, protein_g: 17.3, carbs_g: 2.8, fat_g: 8.7, sodium_mg: 14, fiber_g: 2.3 },
  { name: 'Edamame (Shelled, Cooked)', brand: 'USDA', serving_grams: 100, calories: 121, protein_g: 11.9, carbs_g: 8.9, fat_g: 5.2, sodium_mg: 6, fiber_g: 5.2 },
  { name: 'Black Beans (Cooked)', brand: 'USDA', serving_grams: 100, calories: 132, protein_g: 8.9, carbs_g: 23.7, fat_g: 0.5, sodium_mg: 2, fiber_g: 8.7 },
  { name: 'Chickpeas / Garbanzo (Cooked)', brand: 'USDA', serving_grams: 100, calories: 164, protein_g: 8.9, carbs_g: 27.4, fat_g: 2.6, sodium_mg: 7, fiber_g: 7.6 },
  { name: 'Lentils (Cooked)', brand: 'USDA', serving_grams: 100, calories: 116, protein_g: 9.0, carbs_g: 20.1, fat_g: 0.4, sodium_mg: 2, fiber_g: 7.9 },
  { name: 'Hummus (Standard)', brand: 'Sabra', serving_grams: 100, calories: 166, protein_g: 7.9, carbs_g: 14.3, fat_g: 9.6, sodium_mg: 382, fiber_g: 6.0 },

  // Condiments & Staples
  { name: 'Honey (Pure)', brand: 'USDA', serving_grams: 21, calories: 64, protein_g: 0.1, carbs_g: 17.3, fat_g: 0, sodium_mg: 1, fiber_g: 0 },
  { name: 'Maple Syrup (Pure)', brand: 'USDA', serving_grams: 20, calories: 52, protein_g: 0, carbs_g: 13.4, fat_g: 0, sodium_mg: 2, fiber_g: 0 },
  { name: 'Soy Sauce (Tamari/Shoyu)', brand: 'Kikkoman', serving_grams: 15, calories: 8, protein_g: 1.2, carbs_g: 0.7, fat_g: 0.1, sodium_mg: 879, fiber_g: 0 },
  { name: 'Sriracha Hot Sauce', brand: 'Huy Fong', serving_grams: 10, calories: 10, protein_g: 0.2, carbs_g: 2.1, fat_g: 0.1, sodium_mg: 100, fiber_g: 0.1 },
  { name: 'Dijon Mustard', brand: 'Grey Poupon', serving_grams: 10, calories: 7, protein_g: 0.4, carbs_g: 0.5, fat_g: 0.4, sodium_mg: 120, fiber_g: 0.3 }
];

function searchFoodList(list, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return list.slice(0, 20);

  const tokens = q.split(/\s+/).filter(Boolean);

  const scored = [];
  for (const item of list) {
    const nameLower = (item.name || '').toLowerCase();
    const brandLower = (item.brand || '').toLowerCase();
    const fullText = `${nameLower} ${brandLower}`;

    const matchesAll = tokens.every(tok => fullText.includes(tok));
    if (!matchesAll) continue;

    let score = 0;
    if (nameLower === q) {
      score += 150;
    } else if (nameLower.startsWith(q)) {
      score += 90;
    } else if (nameLower.split(/\s+/).some(w => w.startsWith(tokens[0]))) {
      score += 50;
    }

    const idx = nameLower.indexOf(tokens[0]);
    if (idx !== -1) {
      score += Math.max(0, 25 - idx);
    }

    scored.push({ item, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.item);
}

app.get('/api/foods/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  const isAiSearch = req.query.ai === 'true';

  if (!query && !isAiSearch) return res.json(BUILT_IN_FOODS.slice(0, 15));

  // AI nutrition estimation & permanent caching
  if (isAiSearch && query) {
    const profile = db.prepare('SELECT gemini_api_key FROM profile WHERE id = 1').get();
    const apiKey = process.env.GEMINI_API_KEY || (profile && profile.gemini_api_key);
    if (!apiKey) {
      return res.status(400).json({ error: 'GEMINI_KEY_REQUIRED', message: 'Gemini API key is required for AI nutrition lookup' });
    }

    try {
      const prompt = `You are an expert sports nutrition database encoder.
Provide the standard nutritional values PER 100 GRAMS for: "${query}".
Return ONLY a valid JSON object matching this schema:
{
  "name": "Food Name (clean descriptive name)",
  "brand": "Standard / Brand / USDA",
  "serving_grams": 100,
  "calories": 200,
  "protein_g": 25.0,
  "carbs_g": 0.0,
  "fat_g": 10.0,
  "sodium_mg": 60,
  "fiber_g": 0.0
}
Values must be realistic per 100 grams. Calories must accurately reflect macros (approx 4*P + 4*C + 9*F). Return ONLY the JSON object.`;

      const parsed = await callGemini(apiKey, [{ parts: [{ text: prompt }] }], 0.1);
      if (parsed && parsed.name && typeof parsed.calories === 'number') {
        const newFood = {
          id: crypto.randomUUID(),
          name: String(parsed.name).trim(),
          brand: String(parsed.brand || 'AI Verified').trim(),
          serving_grams: Number(parsed.serving_grams) || 100,
          serving_size_desc: '100g',
          calories: Math.round(Number(parsed.calories)),
          protein_g: Math.round((Number(parsed.protein_g) || 0) * 10) / 10,
          carbs_g: Math.round((Number(parsed.carbs_g) || 0) * 10) / 10,
          fat_g: Math.round((Number(parsed.fat_g) || 0) * 10) / 10,
          sodium_mg: Math.round(Number(parsed.sodium_mg) || 0),
          fiber_g: Math.round((Number(parsed.fiber_g) || 0) * 10) / 10
        };

        try {
          db.prepare(`
            INSERT INTO custom_foods (id, name, brand, serving_size_desc, serving_grams, calories, protein_g, carbs_g, fat_g, sodium_mg, fiber_g)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            newFood.id, newFood.name, newFood.brand, newFood.serving_size_desc, newFood.serving_grams,
            newFood.calories, newFood.protein_g, newFood.carbs_g, newFood.fat_g,
            newFood.sodium_mg, newFood.fiber_g
          );
        } catch (saveErr) {
          console.warn('Failed to cache AI food to SQLite custom_foods:', saveErr);
        }

        return res.json([newFood]);
      }
    } catch (aiErr) {
      console.error('AI food search failed:', aiErr);
      return res.status(500).json({ error: 'AI_SEARCH_FAILED', message: aiErr.message || 'AI estimation failed' });
    }
  }

  // Local SQLite custom_foods search with word tokens
  let customMatches = [];
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length > 0) {
    try {
      const clauses = tokens.map(() => '(LOWER(name) LIKE ? OR LOWER(brand) LIKE ?)').join(' AND ');
      const params = tokens.flatMap(t => [`%${t}%`, `%${t}%`]);
      customMatches = db.prepare(`SELECT * FROM custom_foods WHERE ${clauses} LIMIT 20`).all(...params) || [];
    } catch (_) {}
  }

  const allFoods = [...customMatches, ...BUILT_IN_FOODS];
  let ranked = searchFoodList(allFoods, query);

  // If fewer than 8 matches and query is at least 3 characters, query OpenFoodFacts global database
  if (ranked.length < 8 && query.length >= 3) {
    try {
      const offRes = await fetch(`https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=8`, {
        headers: { 'User-Agent': 'TrackIt-PersonalApp/2.0 (personal-nutrition-tracker)' },
        signal: AbortSignal.timeout(3500)
      });
      if (offRes.ok) {
        const offData = await offRes.json();
        if (offData.products && offData.products.length > 0) {
          const offFoods = offData.products
            .filter(p => p.product_name && p.nutriments)
            .map(p => {
              const n = p.nutriments;
              const cal = Math.round(n['energy-kcal_100g'] || (n['energy_100g'] ? n['energy_100g'] / 4.184 : 0));
              return {
                id: 'off_' + (p.code || crypto.randomUUID()),
                name: p.product_name,
                brand: p.brands || 'Packaged Food',
                serving_grams: 100,
                serving_size_desc: p.serving_size || '100g',
                calories: cal,
                protein_g: Math.round((n.proteins_100g || 0) * 10) / 10,
                carbs_g: Math.round((n.carbohydrates_100g || 0) * 10) / 10,
                fat_g: Math.round((n.fat_100g || 0) * 10) / 10,
                sodium_mg: Math.round((n.sodium_100g || 0) * 1000),
                fiber_g: Math.round((n.fiber_100g || 0) * 10) / 10,
                barcode: p.code || ''
              };
            });
          ranked = [...ranked, ...offFoods];
        }
      }
    } catch (_) {
      // Gracefully retain local matches on timeout
    }
  }

  res.json(ranked.slice(0, 25));
});

// -------------------------------------------------------------
// Gemini Generative Language API Helper with Fast-Path & Self-Healing
// -------------------------------------------------------------
let activeWorkingModel = 'gemini-3.5-flash';
let cachedGeminiModels = null;

async function getAvailableGeminiModels(apiKey) {
  if (cachedGeminiModels && cachedGeminiModels.length > 0) {
    return cachedGeminiModels;
  }
  const cleanKey = String(apiKey || '').trim().replace(/^['"]|['"]$/g, '');
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(cleanKey)}`;
  const res = await fetch(url, {
    headers: { 'x-goog-api-key': cleanKey }
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google ModelService.ListModels failed (HTTP ${res.status}): ${err}`);
  }
  const data = await res.json();
  const models = (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace(/^models\//, ''));

  models.sort((a, b) => {
    const score = m => (m.includes('3.5') ? 100 : 0) + (m.includes('2.5') ? 80 : 0) + (m.includes('3.1') ? 70 : 0) + (m.includes('flash') ? 30 : 0);
    return score(b) - score(a);
  });

  cachedGeminiModels = models;
  if (models.length > 0) {
    activeWorkingModel = models[0];
  }
  return models;
}

async function callGemini(apiKey, contents, temperature = 0.2) {
  const cleanKey = String(apiKey || '').trim().replace(/^['"]|['"]$/g, '');
  if (!cleanKey) {
    throw new Error('Missing Gemini API Key. Please configure GEMINI_API_KEY in environment variables or Settings.');
  }

  const payload = {
    contents,
    generationConfig: {
      temperature,
      responseMimeType: 'application/json'
    }
  };

  // 1. FAST PATH (Zero extra calls): Try activeWorkingModel directly
  try {
    const fastUrl = `https://generativelanguage.googleapis.com/v1beta/models/${activeWorkingModel}:generateContent?key=${encodeURIComponent(cleanKey)}`;
    const fastRes = await fetch(fastUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': cleanKey
      },
      body: JSON.stringify(payload)
    });

    if (fastRes.ok) {
      const data = await fastRes.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
        return JSON.parse(cleaned);
      }
    }

    if (fastRes.status !== 404) {
      const errText = await fastRes.text();
      throw new Error(`Gemini ${activeWorkingModel} (HTTP ${fastRes.status}): ${errText}`);
    }
  } catch (fastErr) {
    if (!fastErr.message.includes('404')) {
      throw fastErr;
    }
    console.warn(`Model ${activeWorkingModel} returned 404. Falling back to dynamic discovery.`);
  }

  // 2. SELF-HEALING FALLBACK: Only reached if the active model was retired or returned 404
  let candidateModels = [];
  try {
    candidateModels = await getAvailableGeminiModels(cleanKey);
  } catch (err) {
    console.error('ListModels error:', err);
    candidateModels = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-3.1-flash-lite', 'gemini-3.0-flash', 'gemini-2.5-pro', 'gemini-3.5-pro'];
  }

  let lastError = null;

  for (const model of candidateModels) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(cleanKey)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': cleanKey
        },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          activeWorkingModel = model;
          const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
          return JSON.parse(cleaned);
        }
      } else {
        const errText = await res.text();
        lastError = `${model} (HTTP ${res.status}): ${errText}`;
        console.error('Gemini error with', model, errText);
      }
    } catch (e) {
      lastError = `${model}: ${e.message}`;
      console.error('Gemini fetch exception with', model, e);
    }
  }

  throw new Error(`Gemini API failed: ${lastError} (Attempted: ${candidateModels.slice(0, 4).join(', ')})`);
}

// AI Diagnostics / Connection Test Endpoint
app.get('/api/ai/test', async (req, res) => {
  try {
    const profile = db.prepare('SELECT gemini_api_key FROM profile WHERE id = 1').get();
    const apiKey = process.env.GEMINI_API_KEY || (profile && profile.gemini_api_key);
    if (!apiKey) return res.status(400).json({ error: 'Missing Gemini API Key' });

    const availableModels = await getAvailableGeminiModels(apiKey);
    const testResult = await callGemini(apiKey, [{ parts: [{ text: 'Return JSON: {"status": "ok", "message": "Gemini connection active"}' }] }]);
    res.json({
      success: true,
      activeModel: availableModels[0] || 'auto',
      availableCount: availableModels.length,
      availableModels: availableModels.slice(0, 10),
      testResponse: testResult
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. AI Food Plate Multimodal Image Scanning (Gemini Vision)
app.post('/api/ai/scan-plate', async (req, res) => {
  try {
    const { imageBase64, mimeType = 'image/jpeg' } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ error: 'imageBase64 required' });
    }

    const profile = db.prepare('SELECT gemini_api_key FROM profile WHERE id = 1').get();
    const apiKey = process.env.GEMINI_API_KEY || (profile && profile.gemini_api_key);

    if (!apiKey) {
      return res.status(400).json({
        error: 'Missing Gemini API Key. Please add your personal Gemini API key in Settings.'
      });
    }

    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');

    const prompt = `You are a world-class professional sports nutritionist and computer vision nutrition assistant.
Analyze this food plate photo in detail.
Identify every visible food, ingredient, side dish, sauce, or beverage on the plate.
All weights must be strictly in METRIC GRAMS (g).
Provide your response strictly in the following JSON format without markdown fences:
{
  "plate_summary": "High protein chicken and rice meal",
  "total_calories": 620,
  "total_protein_g": 48,
  "total_carbs_g": 65,
  "total_fat_g": 18,
  "items": [
    {
      "food_name": "Grilled Chicken Breast",
      "estimated_grams": 180,
      "calories": 297,
      "protein_g": 46.0,
      "carbs_g": 0.0,
      "fat_g": 6.5,
      "sodium_mg": 135,
      "fiber_g": 0.0,
      "confidence": 0.95,
      "assumptions": "Boneless skinless cooked cut"
    }
  ]
}`;

    const contents = [{
      parts: [
        { text: prompt },
        {
          inlineData: {
            mimeType,
            data: cleanBase64
          }
        }
      ]
    }];

    const parsed = await callGemini(apiKey, contents, 0.2);
    res.json(parsed);
  } catch (err) {
    console.error('Scan plate error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 8. AI Personalized Recipe Generator (fitting remaining macros, always using Profile Avoided Ingredients)
app.post('/api/ai/recipes', async (req, res) => {
  try {
    const { date, userPrompt } = req.body;
    const targetDate = date || new Date().toISOString().split('T')[0];

    const profile = db.prepare('SELECT * FROM profile WHERE id = 1').get();
    const apiKey = process.env.GEMINI_API_KEY || (profile && profile.gemini_api_key);

    if (!apiKey) {
      return res.status(400).json({
        error: 'Missing Gemini API Key. Please add your personal Gemini API key in Settings.'
      });
    }

    const targets = calculateTargets(profile);
    const meals = db.prepare('SELECT * FROM meals WHERE date = ?').all(targetDate);
    const totals = meals.reduce((acc, m) => {
      acc.calories += m.calories;
      acc.protein_g += m.protein_g;
      acc.carbs_g += m.carbs_g;
      acc.fat_g += m.fat_g;
      return acc;
    }, { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });

    const remaining = {
      calories: Math.max(0, targets.target_calories - Math.round(totals.calories)),
      protein_g: Math.max(0, targets.target_protein_g - Math.round(totals.protein_g)),
      carbs_g: Math.max(0, targets.target_carbs_g - Math.round(totals.carbs_g)),
      fat_g: Math.max(0, targets.target_fat_g - Math.round(totals.fat_g))
    };

    // Ingredients to avoid are permanently retrieved from Profile
    const avoidedIngredients = (profile.ingredients_to_avoid || 'cilantro, mushrooms').trim();

    const systemPrompt = `You are an elite culinary sports chef specializing in clean lean-bulking and hypertrophy nutrition.
Create 3 distinct, high-protein recipes engineered to match the user's remaining macros for the day.
All ingredient measurements must be strictly in METRIC GRAMS / ML.

User's Goal: Muscle Gain / Lean Bulk
User's Remaining Daily Targets:
- Calories remaining: ~${remaining.calories} kcal
- Protein remaining: ~${remaining.protein_g}g
- Carbs remaining: ~${remaining.carbs_g}g
- Fat remaining: ~${remaining.fat_g}g

PERMANENT RESTRICTION - INGREDIENTS TO STRICTLY AVOID:
"${avoidedIngredients}" (Do NOT include any of these ingredients or their direct derivatives).
${userPrompt ? `- One-off user request: "${userPrompt}"` : ''}

Respond strictly with valid JSON without markdown fences:
{
  "avoided_applied": "${avoidedIngredients}",
  "remaining_context": "Solving ~${remaining.calories} kcal with ${remaining.protein_g}g protein",
  "recipes": [
    {
      "id": "recipe_1",
      "title": "Teriyaki Chicken & Jasmine Rice Power Bowl",
      "description": "High-protein lean bulk staple with quick prep",
      "prep_time_min": 15,
      "difficulty": "Easy",
      "calories": 650,
      "protein_g": 52,
      "carbs_g": 75,
      "fat_g": 16,
      "ingredients": [
        "200g Chicken breast, sliced",
        "220g Cooked jasmine rice",
        "100g Steamed broccoli florets",
        "20ml Low-sodium teriyaki glaze",
        "5ml Sesame oil for cooking"
      ],
      "instructions": [
        "Heat sesame oil in a skillet over high heat.",
        "Sear chicken breast slices for 6 minutes until cooked through.",
        "Stir in teriyaki glaze, simmer for 1 minute.",
        "Serve over warm jasmine rice alongside steamed broccoli."
      ]
    }
  ]
}`;

    const contents = [{ parts: [{ text: systemPrompt }] }];
    const parsed = await callGemini(apiKey, contents, 0.35);
    res.json(parsed);
  } catch (err) {
    console.error('Recipes error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 9. Apple HealthKit Sync Webhook (Metric: kg & cm)
app.post('/api/health/sync', (req, res) => {
  try {
    const profile = db.prepare('SELECT webhook_token, weight_kg, body_fat_pct FROM profile WHERE id = 1').get();
    function cleanWebhookToken(t) {
      if (!t) return '';
      return String(t).trim().replace(/^['"]|['"]$/g, '');
    }

    // Bearer token authentication or body token
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const envToken = cleanWebhookToken(process.env.WEBHOOK_TOKEN);
    const dbToken = cleanWebhookToken(profile && profile.webhook_token);
    const incomingToken = cleanWebhookToken(req.body.token || bearerToken);

    const isValidToken = (envToken && incomingToken === envToken) || (dbToken && incomingToken === dbToken);
    if (!isValidToken) {
      return res.status(401).json({ error: 'Unauthorized: Invalid webhook security token' });
    }

    const {
      date,
      weight_kg,
      weight_lbs,
      body_fat_pct,
      bmi,
      lean_mass_kg,
      sleep_hours,
      sleep_in_bed_hours
    } = req.body;

    const targetDate = date || new Date().toISOString().split('T')[0];

    // Smart normalization for iOS Shortcuts locale quirks (comma stripped as integers or fraction percentages)
    function parseNormalizedWeight(val) {
      if (val === undefined || val === null || val === '') return null;
      let num = typeof val === 'string' ? parseFloat(val.replace(',', '.')) : Number(val);
      if (isNaN(num) || num <= 0) return null;
      if (num >= 300 && num < 3500) {
        num = num / 10; // e.g. 586 -> 58.6 kg
      } else if (num >= 3500 && num < 35000) {
        num = num / 100; // e.g. 5860 -> 58.6 kg
      }
      return Number(num.toFixed(2));
    }

    function parseNormalizedBodyFat(val) {
      if (val === undefined || val === null || val === '') return null;
      let num = typeof val === 'string' ? parseFloat(val.replace(',', '.')) : Number(val);
      if (isNaN(num) || num <= 0) return null;
      // Apple Health stores fraction (e.g. 0.088 for 8.8%)
      if (num <= 1.0) {
        num = num * 100;
      } else if (num > 55 && num <= 100) {
        // If iOS stripped comma like 88 -> 8.8%
        num = num / 10;
      } else if (num > 100) {
        // If comma was stripped by iOS Shortcuts number parser (e.g. 8800000000000001 or 1500000000)
        const str = String(val).replace(/[^0-9]/g, '');
        if (str.length >= 4) {
          let candidate = parseFloat(str.slice(0, 2) + '.' + str.slice(2, 4));
          if (candidate > 55) {
            candidate = candidate / 10;
          }
          num = candidate;
        } else if (num > 100 && num <= 1000) {
          num = num / 10;
        }
      }
      return Number(num.toFixed(1));
    }

    function parseNormalizedSleep(val) {
      if (val === undefined || val === null || val === '') return null;
      if (typeof val === 'number') {
        let num = val;
        if (isNaN(num) || num <= 0) return null;
        if (num > 24 && num <= 1200) num = num / 60;
        else if (num > 1200 && num <= 86400) num = num / 3600;
        return Number(num.toFixed(1));
      }
      const str = String(val).trim();
      const hrMinMatch = str.match(/(\d+)\s*(?:hr|hrs|h|hours?)\s*(\d+)?\s*(?:min|mins|m|minutes?)?/i);
      if (hrMinMatch) {
        const hrs = parseInt(hrMinMatch[1]) || 0;
        const mins = parseInt(hrMinMatch[2]) || 0;
        return Number((hrs + mins / 60).toFixed(1));
      }
      const colonMatch = str.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
      if (colonMatch) {
        const hrs = parseInt(colonMatch[1]) || 0;
        const mins = parseInt(colonMatch[2]) || 0;
        return Number((hrs + mins / 60).toFixed(1));
      }
      const minOnlyMatch = str.match(/^(\d+)\s*(?:min|mins|minutes?)$/i);
      if (minOnlyMatch) return Number((parseInt(minOnlyMatch[1]) / 60).toFixed(1));
      const secOnlyMatch = str.match(/^(\d+)\s*(?:s|sec|seconds?)$/i);
      if (secOnlyMatch) return Number((parseInt(secOnlyMatch[1]) / 3600).toFixed(1));
      let num = parseFloat(str.replace(',', '.'));
      if (isNaN(num) || num <= 0) return null;
      if (num > 24 && num <= 1200) num = num / 60;
      else if (num > 1200 && num <= 86400) num = num / 3600;
      return Number(num.toFixed(1));
    }

    // Priority to weight_kg; convert if scale sends lbs
    let final_weight_kg = parseNormalizedWeight(weight_kg);
    if (final_weight_kg === null && weight_lbs !== undefined && weight_lbs !== null) {
      const rawLbs = typeof weight_lbs === 'string' ? parseFloat(weight_lbs.replace(',', '.')) : Number(weight_lbs);
      const normLbs = rawLbs >= 1000 ? rawLbs / 10 : rawLbs;
      final_weight_kg = Number((normLbs * 0.45359237).toFixed(2));
    }

    const final_body_fat_pct = parseNormalizedBodyFat(body_fat_pct);
    const userHeightCm = Number(profile && profile.height_cm) || 178;
    const final_bmi = bmi ? Number(bmi) : (final_weight_kg ? Number((final_weight_kg / Math.pow(userHeightCm / 100, 2)).toFixed(1)) : null);

    let final_lean_mass_kg = lean_mass_kg !== undefined && lean_mass_kg !== null ? Number(lean_mass_kg) : null;
    if (final_lean_mass_kg === null && final_weight_kg && final_body_fat_pct) {
      final_lean_mass_kg = Number((final_weight_kg * (1 - (final_body_fat_pct / 100))).toFixed(1));
    }

    const final_sleep_hours = parseNormalizedSleep(sleep_hours);
    const final_sleep_in_bed = parseNormalizedSleep(sleep_in_bed_hours);

    const id = crypto.randomUUID();

    db.prepare(`
      INSERT INTO health_metrics (id, date, weight_kg, body_fat_pct, bmi, lean_mass_kg, sleep_hours, sleep_in_bed_hours, synced_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'shortcut')
      ON CONFLICT(date) DO UPDATE SET
        weight_kg = COALESCE(excluded.weight_kg, health_metrics.weight_kg),
        body_fat_pct = COALESCE(excluded.body_fat_pct, health_metrics.body_fat_pct),
        bmi = COALESCE(excluded.bmi, health_metrics.bmi),
        lean_mass_kg = COALESCE(excluded.lean_mass_kg, health_metrics.lean_mass_kg),
        sleep_hours = COALESCE(excluded.sleep_hours, health_metrics.sleep_hours),
        sleep_in_bed_hours = COALESCE(excluded.sleep_in_bed_hours, health_metrics.sleep_in_bed_hours),
        created_at = CURRENT_TIMESTAMP
    `).run(
      id, targetDate, final_weight_kg, final_body_fat_pct, final_bmi,
      final_lean_mass_kg, final_sleep_hours, final_sleep_in_bed
    );

    // Update active profile weight and dynamically adjust targets
    if (final_weight_kg || final_body_fat_pct) {
      const updatedWeight = final_weight_kg || profile.weight_kg;
      const updatedFat = final_body_fat_pct !== null ? final_body_fat_pct : profile.body_fat_pct;

      const newTargets = calculateTargets({
        ...profile,
        weight_kg: updatedWeight,
        body_fat_pct: updatedFat
      });

      db.prepare(`
        UPDATE profile SET
          weight_kg = ?,
          body_fat_pct = ?,
          bmi = ?,
          lean_mass_kg = ?,
          target_calories = ?,
          target_protein_g = ?,
          target_carbs_g = ?,
          target_fat_g = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
      `).run(
        updatedWeight,
        updatedFat,
        newTargets.bmi,
        newTargets.lean_mass_kg,
        newTargets.target_calories,
        newTargets.target_protein_g,
        newTargets.target_carbs_g,
        newTargets.target_fat_g
      );
    }

    res.json({
      success: true,
      message: 'Apple Health data synced successfully (Metric)',
      date: targetDate,
      weight_kg: final_weight_kg,
      body_fat_pct: final_body_fat_pct,
      sleep_hours: final_sleep_hours
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 10. Adaptive Diet Coach (MacroFactor Hypertrophy / Lean Bulk Engine)
app.get('/api/adaptive/check-in', (req, res) => {
  try {
    const profile = db.prepare('SELECT * FROM profile WHERE id = 1').get();
    const targets = calculateTargets(profile);

    const healthHistory = db.prepare(`
      SELECT date, weight_kg, body_fat_pct, lean_mass_kg, sleep_hours
      FROM health_metrics
      WHERE weight_kg IS NOT NULL
      ORDER BY date DESC
      LIMIT 14
    `).all();

    const mealHistory = db.prepare(`
      SELECT date, SUM(calories) as total_cals, SUM(protein_g) as total_protein
      FROM meals
      GROUP BY date
      ORDER BY date DESC
      LIMIT 14
    `).all();

    const dailyData = [];
    const today = new Date();
    for (let i = 0; i < 14; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];

      const h = healthHistory.find(x => x.date === dateStr);
      const m = mealHistory.find(x => x.date === dateStr);

      dailyData.push({
        date: dateStr,
        weight_kg: h ? h.weight_kg : null,
        body_fat_pct: h ? h.body_fat_pct : null,
        calories: m ? Math.round(m.total_cals) : null,
        protein_g: m ? Math.round(m.total_protein) : null
      });
    }

    const weightsWithValues = dailyData.filter(d => d.weight_kg !== null);
    let weightTrendDeltaKg = 0;
    let avgCalories = targets.target_calories;
    let trueTDEE = targets.tdee;
    let recommendation = 'Keep current lean bulk surplus (+250 kcal)';
    let suggestedCalories = targets.target_calories;
    let suggestedProtein = targets.target_protein_g;
    let suggestedCarbs = targets.target_carbs_g;
    let suggestedFat = targets.target_fat_g;
    let confidence = 'Low (Need 4+ morning scale weigh-ins)';

    if (weightsWithValues.length >= 4) {
      const newestWeight = weightsWithValues[0].weight_kg;
      const oldestWeight = weightsWithValues[weightsWithValues.length - 1].weight_kg;
      weightTrendDeltaKg = Number((newestWeight - oldestWeight).toFixed(2));
      const days = weightsWithValues.length;

      const loggedCalories = dailyData.filter(d => d.calories !== null && d.calories > 1000);
      if (loggedCalories.length >= 4) {
        const sumCals = loggedCalories.reduce((s, c) => s + c.calories, 0);
        avgCalories = Math.round(sumCals / loggedCalories.length);

        // 7700 kcal per kilogram of tissue
        const dailyCalorieDeficitOrSurplus = (weightTrendDeltaKg * 7700) / days;
        trueTDEE = Math.round(avgCalories - dailyCalorieDeficitOrSurplus);
        confidence = 'High (Sufficient scale and nutrition logs)';

        const actualWeeklyRateKg = (weightTrendDeltaKg / days) * 7;

        if (profile.goal_type === 'lean_bulk') {
          if (actualWeeklyRateKg < 0.10) {
            // Surplus is too small or NEAT adapted up
            recommendation = `Weight gain is slow (${actualWeeklyRateKg.toFixed(2)} kg/wk). Metabolism has adapted up. We recommend increasing calories by +175 kcal (mostly carbs) to drive hypertrophy.`;
            suggestedCalories = targets.target_calories + 175;
          } else if (actualWeeklyRateKg > 0.45) {
            // Gaining faster than 0.45 kg/wk, potential fat accumulation
            recommendation = `Gaining at +${actualWeeklyRateKg.toFixed(2)} kg/wk. This exceeds optimal lean mass rate. Reduce surplus by -120 kcal for cleaner muscle gain.`;
            suggestedCalories = targets.target_calories - 120;
          } else {
            // Sweet spot: 0.20 to 0.40 kg/wk
            recommendation = `Optimal lean mass gain rate (+${actualWeeklyRateKg.toFixed(2)} kg/wk)! Muscle protein synthesis is maximized with minimal fat accumulation. Keep targets steady.`;
            suggestedCalories = targets.target_calories;
          }
        } else {
          recommendation = `Rate of change: ${actualWeeklyRateKg > 0 ? '+' : ''}${actualWeeklyRateKg.toFixed(2)} kg/week. Maintain course.`;
        }

        const proteinCals = suggestedProtein * 4;
        const fatCals = suggestedFat * 9;
        suggestedCarbs = Math.max(60, Math.round((suggestedCalories - (proteinCals + fatCals)) / 4));
        suggestedCalories = (suggestedProtein * 4) + (suggestedCarbs * 4) + (suggestedFat * 9);
      }
    }

    res.json({
      profile,
      targets,
      history: dailyData,
      weightTrendDeltaKg,
      trueTDEE,
      avgCalories,
      confidence,
      recommendation,
      suggestedAdjustments: {
        target_calories: suggestedCalories,
        target_protein_g: suggestedProtein,
        target_carbs_g: suggestedCarbs,
        target_fat_g: suggestedFat
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 11. Analytics Dashboard
app.get('/api/analytics', (req, res) => {
  try {
    const days = parseInt(req.query.days) || 14;

    const mealDays = db.prepare(`
      SELECT date,
             SUM(calories) as total_cals,
             SUM(protein_g) as total_protein,
             SUM(carbs_g) as total_carbs,
             SUM(fat_g) as total_fat,
             SUM(sodium_mg) as total_sodium,
             SUM(fiber_g) as total_fiber
      FROM meals
      GROUP BY date
      ORDER BY date ASC
    `).all();

    const healthList = db.prepare(`
      SELECT date, weight_kg, body_fat_pct, bmi, lean_mass_kg, sleep_hours
      FROM health_metrics
      ORDER BY date ASC
    `).all();

    const profile = db.prepare('SELECT * FROM profile WHERE id = 1').get();
    const targets = calculateTargets(profile);

    const chartData = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];

      const m = mealDays.find(x => x.date === dateStr) || {
        total_cals: 0, total_protein: 0, total_carbs: 0, total_fat: 0, total_sodium: 0, total_fiber: 0
      };
      const h = healthList.find(x => x.date === dateStr) || {
        weight_kg: null, body_fat_pct: null, bmi: null, lean_mass_kg: null, sleep_hours: null
      };

      const deviation = m.total_cals > 0 ? Math.round(m.total_cals - targets.target_calories) : null;

      chartData.push({
        date: dateStr,
        calories: Math.round(m.total_cals),
        protein_g: Math.round(m.total_protein),
        carbs_g: Math.round(m.total_carbs),
        fat_g: Math.round(m.total_fat),
        sodium_mg: Math.round(m.total_sodium),
        fiber_g: Math.round(m.total_fiber),
        target_calories: targets.target_calories,
        deviation,
        weight_kg: h.weight_kg,
        body_fat_pct: h.body_fat_pct,
        sleep_hours: h.sleep_hours
      });
    }

    res.json({ chartData, targets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`TrackIt (Metric) server running on http://localhost:${PORT}`);
  console.log(`Access on your local Wi-Fi / iPhone via: http://<your-mac-ip>:${PORT}`);
});
