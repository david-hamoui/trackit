-- schema.sql - Cloudflare D1 Database Schema for TrackIt (Metric)

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
  commitment_rate REAL DEFAULT 250,
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
  meal_type TEXT NOT NULL,
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
  source TEXT DEFAULT 'manual',
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

-- Seed default profile row
INSERT OR IGNORE INTO profile (id, name, age, sex, height_cm, weight_kg, body_fat_pct, goal_type, commitment_rate, ingredients_to_avoid, webhook_token)
VALUES (1, 'David', 28, 'male', 178, 78.0, 15.0, 'lean_bulk', 250, 'cilantro, mushrooms', 'replace_with_your_secret_token');
