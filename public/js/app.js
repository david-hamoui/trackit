// TrackIt - Frontend Application Engine (Metric System)
document.addEventListener('DOMContentLoaded', () => {
  // Global State
  const state = {
    currentDate: getLocalDateString(new Date()),
    profile: null,
    dayData: {
      meals: [],
      totals: { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, sodium_mg: 0, fiber_g: 0 },
      health: null
    },
    activeTab: 'today',
    selectedFoodForAdd: null,
    targetMealType: 'lunch',
    scannedAiResult: null,
    searchDebounceTimer: null
  };

  // Helper: Format date as YYYY-MM-DD
  function getLocalDateString(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  // Helper: Pretty date label
  function formatDisplayDate(dateStr) {
    const todayStr = getLocalDateString(new Date());
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yestStr = getLocalDateString(yesterday);

    if (dateStr === todayStr) return 'Today';
    if (dateStr === yestStr) return 'Yesterday';

    const parts = dateStr.split('-');
    const d = new Date(parts[0], parts[1] - 1, parts[2]);
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }

  // Toast Notification
  function showToast(message, duration = 2500) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // -------------------------------------------------------------
  // Security & App PIN Management (Permanent on device)
  // -------------------------------------------------------------
  const pinLockOverlay = document.getElementById('pin-lock-overlay');
  const pinLockInput = document.getElementById('pin-lock-input');
  const pinUnlockBtn = document.getElementById('pin-unlock-btn');
  const pinErrorMsg = document.getElementById('pin-error-msg');

  // Check URL query param ?pin=XXXX and permanently remember it
  const urlParams = new URLSearchParams(window.location.search);
  const queryPin = urlParams.get('pin');
  if (queryPin) {
    localStorage.setItem('trackit_pin', queryPin.trim());
    urlParams.delete('pin');
    const newSearch = urlParams.toString() ? '?' + urlParams.toString() : '';
    window.history.replaceState({}, document.title, window.location.pathname + newSearch);
  }

  function showPinLockOverlay() {
    if (pinLockOverlay) {
      pinLockOverlay.style.display = 'flex';
      if (pinLockInput) {
        pinLockInput.value = '';
        setTimeout(() => pinLockInput.focus(), 150);
      }
    }
  }

  function hidePinLockOverlay() {
    if (pinLockOverlay) {
      pinLockOverlay.style.display = 'none';
    }
    if (pinErrorMsg) {
      pinErrorMsg.style.display = 'none';
    }
  }

  async function handleUnlock() {
    if (!pinLockInput) return;
    const pin = (pinLockInput.value || '').trim();
    if (!pin) {
      if (pinErrorMsg) {
        pinErrorMsg.style.display = 'block';
        pinErrorMsg.textContent = 'Please enter your passcode.';
      }
      return;
    }

    try {
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-App-Pin': pin },
        body: JSON.stringify({ pin })
      });
      if (res.ok) {
        localStorage.setItem('trackit_pin', pin);
        hidePinLockOverlay();
        showToast('App unlocked permanently on this device');
        updatePinStatusUI();
        loadProfile();
        loadDayData(state.currentDate);
      } else {
        if (pinErrorMsg) {
          pinErrorMsg.style.display = 'block';
          pinErrorMsg.textContent = 'Incorrect PIN. Please try again.';
        }
        pinLockInput.select();
      }
    } catch (err) {
      console.error(err);
      if (pinErrorMsg) {
        pinErrorMsg.style.display = 'block';
        pinErrorMsg.textContent = 'Verification error. Check internet connection.';
      }
    }
  }

  if (pinUnlockBtn) {
    pinUnlockBtn.addEventListener('click', handleUnlock);
  }
  if (pinLockInput) {
    pinLockInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleUnlock();
    });
  }

  function updatePinStatusUI() {
    const statusBox = document.getElementById('device-pin-status-box');
    const hasPin = Boolean(localStorage.getItem('trackit_pin'));
    if (statusBox) {
      if (hasPin) {
        statusBox.innerHTML = '🔒 Passcode saved permanently on this device';
        statusBox.style.color = 'var(--accent-success)';
      } else {
        statusBox.innerHTML = '🔓 No PIN currently saved on this device';
        statusBox.style.color = 'var(--text-secondary)';
      }
    }
  }

  const lockDeviceBtn = document.getElementById('lock-device-btn');
  if (lockDeviceBtn) {
    lockDeviceBtn.addEventListener('click', () => {
      localStorage.removeItem('trackit_pin');
      updatePinStatusUI();
      showToast('TrackIt locked on this device');
      showPinLockOverlay();
    });
  }

  // Authenticated fetch wrapper that attaches permanent device PIN
  async function apiFetch(url, options = {}) {
    const pin = localStorage.getItem('trackit_pin') || '';
    const headers = { ...(options.headers || {}) };
    if (pin) {
      headers['X-App-Pin'] = pin;
    }
    const res = await fetch(url, { ...options, headers });
    if (res.status === 401) {
      try {
        const clone = res.clone();
        const data = await clone.json();
        if (data.error === 'PIN_REQUIRED' || data.error === 'INVALID_PIN') {
          showPinLockOverlay();
        }
      } catch (_) {
        showPinLockOverlay();
      }
    }
    return res;
  }

  // -------------------------------------------------------------
  // Data Fetching & Sync
  // -------------------------------------------------------------
  async function loadProfile() {
    try {
      const res = await apiFetch('/api/profile');
      if (!res.ok) throw new Error('Failed to load profile');
      state.profile = await res.json();
      renderProfileForm();
      renderCalculatedTargets();
      updatePinStatusUI();
    } catch (err) {
      console.error(err);
      showToast('Error loading profile');
    }
  }

  async function loadDayData(date = state.currentDate) {
    try {
      const res = await apiFetch(`/api/meals?date=${date}`);
      if (!res.ok) throw new Error('Failed to load day logs');
      state.dayData = await res.json();
      renderTodayView();
      updateRecipeRemainingContext();
    } catch (err) {
      console.error(err);
      showToast('Error loading meals');
    }
  }

  // -------------------------------------------------------------
  // Render: Today View (Rings, Bars, Meals)
  // -------------------------------------------------------------
  function renderTodayView() {
    const p = state.profile;
    const totals = state.dayData.totals || { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, sodium_mg: 0, fiber_g: 0 };
    const health = state.dayData.health;

    document.getElementById('current-date-label').textContent = formatDisplayDate(state.currentDate);

    if (!p) return;

    const targetCals = p.target_calories || 3050;
    const targetPro = p.target_protein_g || 165;
    const targetCarbs = p.target_carbs_g || 430;
    const targetFat = p.target_fat_g || 75;
    const targetSodium = p.target_sodium_mg || 2300;
    const targetFiber = p.target_fiber_g || 38;

    const remainingCals = Math.round(targetCals - totals.calories);
    document.getElementById('cals-remaining-val').textContent = remainingCals;
    document.getElementById('cal-text-fraction').textContent = `${Math.round(totals.calories)} / ${targetCals} kcal`;
    document.getElementById('pro-text-fraction').textContent = `${Math.round(totals.protein_g)} / ${targetPro}g`;
    document.getElementById('carb-text-fraction').textContent = `${Math.round(totals.carbs_g)} / ${targetCarbs}g`;
    document.getElementById('fat-text-fraction').textContent = `${Math.round(totals.fat_g)} / ${targetFat}g`;

    // Progress Bars
    const pctCal = Math.min(100, Math.round((totals.calories / targetCals) * 100));
    const pctPro = Math.min(100, Math.round((totals.protein_g / targetPro) * 100));
    const pctCarb = Math.min(100, Math.round((totals.carbs_g / targetCarbs) * 100));
    const pctFat = Math.min(100, Math.round((totals.fat_g / targetFat) * 100));

    document.getElementById('bar-cal').style.width = `${pctCal}%`;
    document.getElementById('bar-pro').style.width = `${pctPro}%`;
    document.getElementById('bar-carb').style.width = `${pctCarb}%`;
    document.getElementById('bar-fat').style.width = `${pctFat}%`;

    // SVG Macro Rings
    const calCirc = 364.4;
    const calOffset = calCirc - (Math.min(1, totals.calories / targetCals) * calCirc);
    document.getElementById('ring-cal-fg').style.strokeDashoffset = calOffset;

    const proCirc = 276.4;
    const proOffset = proCirc - (Math.min(1, totals.protein_g / targetPro) * proCirc);
    document.getElementById('ring-pro-fg').style.strokeDashoffset = proOffset;

    const carbCirc = 188.5;
    const carbOffset = carbCirc - (Math.min(1, totals.carbs_g / targetCarbs) * carbCirc);
    document.getElementById('ring-carb-fg').style.strokeDashoffset = carbOffset;

    // Micronutrients & Surplus Badge
    document.getElementById('sodium-val').textContent = Math.round(totals.sodium_mg || 0);
    document.getElementById('sodium-goal').textContent = targetSodium;
    document.getElementById('fiber-val').textContent = Math.round(totals.fiber_g || 0);
    document.getElementById('fiber-goal').textContent = targetFiber;

    const rateSign = p.commitment_rate > 0 ? '+' : '';
    document.getElementById('burn-rate-badge').textContent = `${rateSign}${p.commitment_rate} kcal`;

    // Scale Weight in Metric (kg)
    if (health && health.weight_kg) {
      document.getElementById('scale-weight-display').textContent = `${health.weight_kg} kg`;
      document.getElementById('scale-fat-display').textContent = health.body_fat_pct ? `(${health.body_fat_pct}% fat)` : '';
    } else {
      document.getElementById('scale-weight-display').textContent = `${p.weight_kg || '--'} kg`;
      document.getElementById('scale-fat-display').textContent = p.body_fat_pct ? `(${p.body_fat_pct}% fat)` : '';
    }

    if (health && health.sleep_hours) {
      document.getElementById('sleep-display').textContent = `${health.sleep_hours} hrs`;
    } else {
      document.getElementById('sleep-display').textContent = '-- hrs';
    }

    renderMealSections(state.dayData.meals || []);
  }

  function renderMealSections(meals) {
    const mealTypes = ['breakfast', 'lunch', 'dinner', 'snack'];
    const grouped = { breakfast: [], lunch: [], dinner: [], snack: [] };

    meals.forEach(m => {
      const type = (m.meal_type || 'snack').toLowerCase();
      if (grouped[type]) grouped[type].push(m);
      else grouped['snack'].push(m);
    });

    mealTypes.forEach(type => {
      const container = document.getElementById(`${type}-items`);
      const calsLabel = document.getElementById(`${type}-cals`);
      const items = grouped[type];

      const subtotalCals = items.reduce((s, x) => s + x.calories, 0);
      calsLabel.textContent = `${Math.round(subtotalCals)} kcal`;

      if (items.length === 0) {
        container.innerHTML = `<div class="empty-meal-hint">No food logged yet for ${type}</div>`;
      } else {
        container.innerHTML = items.map(item => `
          <div class="meal-food-row" data-id="${item.id}">
            <div class="food-info-col">
              <div class="food-row-name">
                ${escapeHtml(item.food_name)}
                ${item.source === 'ai_scan' ? '<span class="food-source-badge">AI Scan</span>' : ''}
              </div>
              <div class="food-row-sub">
                <span>${item.serving_unit && item.serving_unit !== 'g' && item.servings ? `${item.servings} ${item.serving_unit} (${item.grams}g)` : `${item.grams || 100}g`}</span>
                ${item.brand ? `<span>&bull; ${escapeHtml(item.brand)}</span>` : ''}
              </div>
            </div>
            <div class="food-macros-col">
              <div>
                <div class="food-cals-val">${Math.round(item.calories)} kcal</div>
                <div class="food-macro-pills">
                  <span class="pill-p">${Math.round(item.protein_g)}P</span>
                  <span class="pill-c">${Math.round(item.carbs_g)}C</span>
                  <span class="pill-f">${Math.round(item.fat_g)}F</span>
                </div>
              </div>
              <button class="delete-meal-btn" data-delete-id="${item.id}" aria-label="Delete item">
                <svg style="width: 16px; height: 16px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>
          </div>
        `).join('');
      }
    });

    document.querySelectorAll('.delete-meal-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-delete-id');
        if (!id) return;
        try {
          const res = await apiFetch(`/api/meals/${id}`, { method: 'DELETE' });
          if (res.ok) {
            showToast('Item deleted');
            loadDayData();
          }
        } catch (err) {
          showToast('Failed to delete item');
        }
      });
    });
  }

  // -------------------------------------------------------------
  // Add Food Modal & Search
  // -------------------------------------------------------------
  const modalAddFood = document.getElementById('modal-add-food');
  const foodSearchInput = document.getElementById('food-search-input');
  const foodSearchList = document.getElementById('food-search-list');
  const foodPortionConfig = document.getElementById('food-portion-config');
  const foodPortionAmount = document.getElementById('food-portion-amount');
  const foodPortionUnit = document.getElementById('food-portion-unit');
  const quickPortionPills = document.getElementById('quick-portion-pills');
  const portionWeightCalc = document.getElementById('portion-weight-calc');

  function openAddFoodModal(mealType) {
    state.targetMealType = mealType;
    document.getElementById('modal-meal-name').textContent = mealType.charAt(0).toUpperCase() + mealType.slice(1);
    foodSearchInput.value = '';
    foodPortionConfig.style.display = 'none';
    modalAddFood.classList.add('active');
    triggerFoodSearch('');
    setTimeout(() => foodSearchInput.focus(), 150);
  }

  function closeAddFoodModal() {
    modalAddFood.classList.remove('active');
  }

  async function triggerFoodSearch(query) {
    try {
      foodSearchList.innerHTML = `<div style="text-align: center; padding: 20px;"><div class="spinner" style="margin: 0 auto;"></div></div>`;
      const res = await apiFetch(`/api/foods/search?q=${encodeURIComponent(query)}`);

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        if (errData.error === 'PIN_REQUIRED' || errData.error === 'INVALID_PIN') {
          showPinLockOverlay();
          return;
        }
        throw new Error(errData.message || 'Failed to search foods');
      }

      const data = await res.json();
      const foods = Array.isArray(data) ? data : [];

      if (foods.length === 0) {
        const cleanQ = query.trim();
        foodSearchList.innerHTML = `
          <div style="text-align: center; color: var(--text-muted); padding: 24px 16px; font-size: 0.85rem;">
            <div style="margin-bottom: 6px;">No foods found for "${escapeHtml(cleanQ || '...')}"</div>
            ${cleanQ.length >= 2 ? `
              <div style="font-size: 0.75rem; color: var(--text-secondary); margin-bottom: 12px;">Ask Gemini AI to estimate & permanently save 100g standard macros:</div>
              <button id="ai-estimate-food-btn" class="btn-secondary" style="font-size: 0.82rem; padding: 8px 16px; border-color: var(--cal-color); color: var(--cal-color); display: inline-flex; align-items: center; gap: 6px; margin: 0 auto;">
                ✨ Estimate & Cache "${escapeHtml(cleanQ)}"
              </button>
            ` : ''}
          </div>`;

        const aiBtn = document.getElementById('ai-estimate-food-btn');
        if (aiBtn) {
          aiBtn.addEventListener('click', () => runAiFoodEstimation(cleanQ));
        }
        return;
      }

      renderFoodSearchResults(foods);
    } catch (err) {
      foodSearchList.innerHTML = `<div style="text-align: center; color: #ef4444; padding: 14px; font-size: 0.82rem;">${escapeHtml(err.message || 'Failed to load foods')}</div>`;
    }
  }

  function renderFoodSearchResults(foods) {
    foodSearchList.innerHTML = foods.map((f, idx) => `
      <div class="food-search-item" data-idx="${idx}">
        <div>
          <div style="font-weight: 700; font-size: 0.88rem; color: var(--text-primary);">${escapeHtml(f.name)}</div>
          <div style="font-size: 0.75rem; color: var(--text-secondary);">${f.brand || 'Verified Food'} &bull; ${f.serving_grams || 100}g</div>
        </div>
        <div style="text-align: right;">
          <div style="font-weight: 700; font-size: 0.88rem; color: var(--cal-color);">${Math.round(f.calories)} kcal</div>
          <div style="font-size: 0.72rem; color: var(--text-secondary);">
            <span class="pill-p">${Math.round(f.protein_g)}P</span>
            <span class="pill-c">${Math.round(f.carbs_g)}C</span>
            <span class="pill-f">${Math.round(f.fat_g)}F</span>
          </div>
        </div>
      </div>
    `).join('');

    foodSearchList.querySelectorAll('.food-search-item').forEach(item => {
      item.addEventListener('click', () => {
        const idx = parseInt(item.getAttribute('data-idx'));
        selectFoodItem(foods[idx]);
      });
    });
  }

  async function runAiFoodEstimation(query) {
    try {
      foodSearchList.innerHTML = `
        <div style="text-align: center; padding: 24px;">
          <div class="spinner" style="margin: 0 auto 12px;"></div>
          <div style="font-size: 0.84rem; color: var(--text-primary); font-weight: 600;">Asking Gemini AI Nutritionist...</div>
          <div style="font-size: 0.74rem; color: var(--text-secondary); margin-top: 4px;">Calculating standard 100g metric macros for "${escapeHtml(query)}"</div>
        </div>`;

      const res = await apiFetch(`/api/foods/search?q=${encodeURIComponent(query)}&ai=true`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || 'AI estimation failed');
      }

      const foods = await res.json();
      if (!Array.isArray(foods) || foods.length === 0) {
        throw new Error('No nutrition estimates returned');
      }

      renderFoodSearchResults(foods);
      selectFoodItem(foods[0]);
      showToast(`Added "${foods[0].name}" to your foods!`);
    } catch (err) {
      foodSearchList.innerHTML = `
        <div style="text-align: center; color: #ef4444; padding: 18px; font-size: 0.82rem;">
          <div>Failed to estimate: ${escapeHtml(err.message)}</div>
          <button id="retry-search-btn" class="btn-secondary" style="margin-top: 10px; font-size: 0.75rem; padding: 6px 12px;">Back to Search</button>
        </div>`;
      const retryBtn = document.getElementById('retry-search-btn');
      if (retryBtn) retryBtn.addEventListener('click', () => triggerFoodSearch(query));
    }
  }

  function getFoodUnits(food) {
    const name = (food.name || '').toLowerCase();
    const baseGrams = Number(food.serving_grams) || 100;

    const units = [
      { id: 'g', label: 'Grams (g)', factor: 1, defaultAmount: baseGrams, pills: [50, 100, 150, 200, 250] },
      { id: 'oz', label: 'Ounces (oz)', factor: 28.3495, defaultAmount: Number((baseGrams / 28.3495).toFixed(1)) || 3.5, pills: [2, 4, 6, 8, 10, 12] }
    ];

    // Liquids & Dairy Beverages
    if (name.includes('milk') || name.includes('juice') || name.includes('water') || name.includes('shake') || name.includes('coffee') || name.includes('oil') || name.includes('syrup') || name.includes('sauce') || name.includes('vinegar')) {
      units.push({ id: 'ml', label: 'Milliliters (ml)', factor: 1, defaultAmount: 100, pills: [50, 100, 150, 200, 250] });
      units.push({ id: 'cup', label: 'Cup (240 ml)', factor: 240, defaultAmount: 1, pills: [0.5, 0.75, 1, 1.5, 2] });
      units.push({ id: 'tbsp', label: 'Tablespoon (15 ml)', factor: 15, defaultAmount: 1, pills: [1, 2, 3, 4] });
      units.push({ id: 'tsp', label: 'Teaspoon (5 ml)', factor: 5, defaultAmount: 1, pills: [1, 2, 3] });
    }
    // Yogurts & Cottage Cheese
    else if (name.includes('yogurt') || name.includes('skyr') || name.includes('cottage cheese') || name.includes('sour cream')) {
      units.push({ id: 'cup', label: 'Cup (~245 g)', factor: 245, defaultAmount: 1, pills: [0.5, 0.75, 1, 1.5] });
      units.push({ id: 'tbsp', label: 'Tablespoon (~15 g)', factor: 15, defaultAmount: 2, pills: [1, 2, 3, 4] });
    }
    // Nut butters & Spreads
    else if (name.includes('peanut butter') || name.includes('almond butter') || name.includes('butter') || name.includes('ghee') || name.includes('mayo') || name.includes('hummus')) {
      units.push({ id: 'tbsp', label: 'Tablespoon (~16 g)', factor: 16, defaultAmount: 2, pills: [1, 2, 3, 4] });
      units.push({ id: 'tsp', label: 'Teaspoon (~5 g)', factor: 5, defaultAmount: 1, pills: [1, 2, 3] });
      units.push({ id: 'cup', label: 'Cup (~250 g)', factor: 250, defaultAmount: 0.5, pills: [0.25, 0.5, 1] });
    }
    // Grains: Cooked Rice, Quinoa, Couscous
    else if (name.includes('rice') && !name.includes('cake') && !name.includes('cream of')) {
      const isDry = name.includes('dry') || name.includes('uncooked');
      const cupWeight = isDry ? 185 : 158;
      units.push({ id: 'cup', label: `Cup (${cupWeight} g)`, factor: cupWeight, defaultAmount: 1, pills: [0.5, 1, 1.5, 2] });
      units.push({ id: 'tbsp', label: 'Tablespoon (~15 g)', factor: 15, defaultAmount: 3, pills: [2, 3, 4, 6] });
    }
    // Pasta & Noodles
    else if (name.includes('pasta') || name.includes('spaghetti') || name.includes('noodle')) {
      const isDry = name.includes('dry');
      const cupWeight = isDry ? 100 : 140;
      units.push({ id: 'cup', label: `Cup (${cupWeight} g)`, factor: cupWeight, defaultAmount: 1, pills: [0.5, 1, 1.5, 2] });
    }
    // Oats & Cereals
    else if (name.includes('oat') || name.includes('cereal') || name.includes('granola')) {
      units.push({ id: 'cup', label: 'Cup dry (80 g)', factor: 80, defaultAmount: 0.5, pills: [0.25, 0.5, 0.75, 1, 1.5] });
      units.push({ id: 'tbsp', label: 'Tablespoon (~10 g)', factor: 10, defaultAmount: 3, pills: [2, 4, 6] });
    }
    // Protein Powders
    else if (name.includes('protein') || name.includes('whey') || name.includes('casein')) {
      units.push({ id: 'scoop', label: `Scoop (${baseGrams} g)`, factor: baseGrams, defaultAmount: 1, pills: [0.5, 1, 1.5, 2] });
      units.push({ id: 'tbsp', label: 'Tablespoon (~10 g)', factor: 10, defaultAmount: 2, pills: [1, 2, 3, 4] });
    }
    // Eggs
    else if (name.includes('egg') && !name.includes('white')) {
      units.unshift({ id: 'egg', label: 'Large Egg (50 g)', factor: 50, defaultAmount: 2, pills: [1, 2, 3, 4, 5] });
    }
    else if (name.includes('egg white')) {
      units.push({ id: 'cup', label: 'Cup (240 g)', factor: 240, defaultAmount: 1, pills: [0.5, 1, 1.5] });
      units.push({ id: 'white', label: 'White of 1 egg (33 g)', factor: 33, defaultAmount: 3, pills: [2, 3, 4, 5, 6] });
    }
    // Bread & Bakery
    else if (name.includes('bread') || name.includes('toast')) {
      units.unshift({ id: 'slice', label: 'Slice (~38 g)', factor: 38, defaultAmount: 2, pills: [1, 2, 3, 4] });
    }
    else if (name.includes('bagel')) {
      units.unshift({ id: 'bagel', label: 'Whole Bagel (105 g)', factor: 105, defaultAmount: 1, pills: [0.5, 1, 2] });
    }
    else if (name.includes('tortilla') || name.includes('wrap')) {
      units.unshift({ id: 'tortilla', label: 'Tortilla (~50 g)', factor: 50, defaultAmount: 1, pills: [1, 2, 3] });
    }
    else if (name.includes('rice cake')) {
      units.unshift({ id: 'cake', label: 'Rice Cake (9 g)', factor: 9, defaultAmount: 2, pills: [1, 2, 3, 4] });
    }
    // Meats & Steaks
    else if (name.includes('steak') || name.includes('beef') || name.includes('chop') || name.includes('roast') || name.includes('brisket')) {
      units.push({ id: 'portion', label: 'Steak Cut (~200 g)', factor: 200, defaultAmount: 1, pills: [0.5, 1, 1.5] });
      units.push({ id: 'lb', label: 'Pound (lb - 453.6 g)', factor: 453.59, defaultAmount: 0.5, pills: [0.25, 0.5, 0.75, 1] });
    }
    // Poultry
    else if (name.includes('chicken') || name.includes('turkey') || name.includes('duck')) {
      if (name.includes('breast') || name.includes('thigh')) {
        units.push({ id: 'piece', label: 'Breast / Piece (~170 g)', factor: 170, defaultAmount: 1, pills: [0.5, 1, 1.5, 2] });
      } else if (name.includes('wing')) {
        units.push({ id: 'wing', label: 'Wing (~35 g)', factor: 35, defaultAmount: 4, pills: [2, 4, 6, 8] });
      }
      units.push({ id: 'cup', label: 'Cup diced (~140 g)', factor: 140, defaultAmount: 1, pills: [0.5, 1, 1.5] });
      units.push({ id: 'lb', label: 'Pound (lb - 453.6 g)', factor: 453.59, defaultAmount: 0.5, pills: [0.5, 1] });
    }
    // Fish & Seafood
    else if (name.includes('salmon') || name.includes('tuna') || name.includes('cod') || name.includes('tilapia') || name.includes('fish')) {
      units.push({ id: 'fillet', label: 'Fillet (~170 g)', factor: 170, defaultAmount: 1, pills: [0.5, 1, 1.5, 2] });
      if (name.includes('canned') || name.includes('can')) {
        units.push({ id: 'can', label: 'Can drained (~120 g)', factor: 120, defaultAmount: 1, pills: [0.5, 1, 2] });
      }
    }
    else if (name.includes('shrimp') || name.includes('prawn')) {
      units.push({ id: 'cup', label: 'Cup (~145 g)', factor: 145, defaultAmount: 1, pills: [0.5, 1, 1.5] });
      units.push({ id: 'piece', label: 'Medium Shrimp (~12 g)', factor: 12, defaultAmount: 8, pills: [4, 6, 8, 12] });
    }
    // Fruits
    else if (name.includes('banana')) {
      units.unshift({ id: 'banana', label: 'Medium Banana (118 g)', factor: 118, defaultAmount: 1, pills: [0.5, 1, 1.5, 2] });
      units.push({ id: 'cup', label: 'Cup sliced (150 g)', factor: 150, defaultAmount: 1, pills: [0.5, 1, 1.5] });
    }
    else if (name.includes('apple')) {
      units.unshift({ id: 'apple', label: 'Medium Apple (180 g)', factor: 180, defaultAmount: 1, pills: [0.5, 1, 2] });
      units.push({ id: 'cup', label: 'Cup sliced (125 g)', factor: 125, defaultAmount: 1, pills: [0.5, 1, 1.5] });
    }
    else if (name.includes('berry') || name.includes('berries') || name.includes('blueberr') || name.includes('strawberr')) {
      units.push({ id: 'cup', label: 'Cup (~150 g)', factor: 150, defaultAmount: 1, pills: [0.5, 0.75, 1, 1.5] });
    }
    // Vegetables
    else if (name.includes('broccoli') || name.includes('spinach') || name.includes('asparagus') || name.includes('bean') || name.includes('pepper') || name.includes('mushroom') || name.includes('salad')) {
      const cupW = name.includes('spinach') || name.includes('salad') ? 30 : 90;
      units.push({ id: 'cup', label: `Cup (${cupW} g)`, factor: cupW, defaultAmount: 1, pills: [0.5, 1, 1.5, 2] });
      units.push({ id: 'tbsp', label: 'Tablespoon (~15 g)', factor: 15, defaultAmount: 2, pills: [1, 2, 3] });
    }
    // Legumes
    else if (name.includes('bean') || name.includes('chickpea') || name.includes('lentil')) {
      units.push({ id: 'cup', label: 'Cup cooked (~180 g)', factor: 180, defaultAmount: 1, pills: [0.5, 1, 1.5] });
      units.push({ id: 'tbsp', label: 'Tablespoon (~15 g)', factor: 15, defaultAmount: 3, pills: [2, 3, 4] });
    }
    // General food fallback
    else {
      units.push({ id: 'cup', label: 'Cup (~180 g)', factor: 180, defaultAmount: 1, pills: [0.5, 1, 1.5] });
      units.push({ id: 'tbsp', label: 'Tablespoon (~15 g)', factor: 15, defaultAmount: 1, pills: [1, 2, 3] });
    }

    if (baseGrams !== 100 && !units.some(u => u.id === 'scoop' || u.id === 'egg' || u.id === 'slice')) {
      units.push({ id: 'serving', label: `Standard Serving (${baseGrams} g)`, factor: baseGrams, defaultAmount: 1, pills: [0.5, 1, 1.5, 2] });
    }

    return units;
  }

  function selectFoodItem(food) {
    state.selectedFoodForAdd = food;
    document.getElementById('selected-food-name').textContent = food.name;
    document.getElementById('selected-food-sub').innerHTML = `${food.brand || 'Verified'} &bull; Base 100g: <strong>${Math.round(food.calories)} kcal</strong> &bull; ${food.protein_g}P ${food.carbs_g}C ${food.fat_g}F`;

    const units = getFoodUnits(food);
    state.currentFoodUnits = units;

    foodPortionUnit.innerHTML = units.map(u => `
      <option value="${u.id}">${escapeHtml(u.label)}</option>
    `).join('');

    const activeUnit = units[0];
    foodPortionUnit.value = activeUnit.id;
    foodPortionAmount.value = activeUnit.defaultAmount || 1;

    renderPortionQuickPills(activeUnit);
    updatePortionPreview();

    foodPortionConfig.style.display = 'block';
    foodPortionConfig.scrollIntoView({ behavior: 'smooth' });
  }

  function renderPortionQuickPills(unit) {
    if (!quickPortionPills) return;
    const pills = unit.pills || [0.5, 1, 1.5, 2];
    const currentVal = parseFloat(foodPortionAmount.value);

    quickPortionPills.innerHTML = pills.map(val => `
      <button type="button" class="portion-pill ${currentVal === val ? 'active' : ''}" data-val="${val}">
        ${val}${unit.id === 'g' || unit.id === 'ml' ? unit.id : ' ' + unit.id}
      </button>
    `).join('');

    quickPortionPills.querySelectorAll('.portion-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        const val = parseFloat(btn.getAttribute('data-val'));
        foodPortionAmount.value = val;
        quickPortionPills.querySelectorAll('.portion-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        updatePortionPreview();
      });
    });
  }

  function updatePortionPreview() {
    const f = state.selectedFoodForAdd;
    if (!f || !state.currentFoodUnits) return;

    const selectedUnitId = foodPortionUnit.value;
    const unit = state.currentFoodUnits.find(u => u.id === selectedUnitId) || { factor: 1, id: 'g' };
    const amount = parseFloat(foodPortionAmount.value) || 0;
    const grams = Math.round((amount * unit.factor) * 10) / 10;
    const baseGrams = f.serving_grams || 100;
    const ratio = grams / baseGrams;

    if (portionWeightCalc) {
      portionWeightCalc.textContent = unit.id === 'g'
        ? `= ${grams} grams`
        : `= ${grams} grams (${amount} ${unit.id})`;
    }

    const cals = Math.round(f.calories * ratio);
    const p = (f.protein_g * ratio).toFixed(1);
    const c = (f.carbs_g * ratio).toFixed(1);
    const fat = (f.fat_g * ratio).toFixed(1);

    document.getElementById('preview-cals').textContent = cals;
    document.getElementById('preview-pro').textContent = `${p}g`;
    document.getElementById('preview-carb').textContent = `${c}g`;
    document.getElementById('preview-fat').textContent = `${fat}g`;
  }

  foodPortionUnit.addEventListener('change', () => {
    const selectedUnitId = foodPortionUnit.value;
    const unit = (state.currentFoodUnits || []).find(u => u.id === selectedUnitId);
    if (unit) {
      foodPortionAmount.value = unit.defaultAmount || 1;
      renderPortionQuickPills(unit);
      updatePortionPreview();
    }
  });

  foodPortionAmount.addEventListener('input', () => {
    const selectedUnitId = foodPortionUnit.value;
    const unit = (state.currentFoodUnits || []).find(u => u.id === selectedUnitId);
    if (unit) {
      renderPortionQuickPills(unit);
    }
    updatePortionPreview();
  });

  document.getElementById('confirm-add-food-btn').addEventListener('click', async () => {
    const f = state.selectedFoodForAdd;
    if (!f || !state.currentFoodUnits) return;

    const selectedUnitId = foodPortionUnit.value;
    const unit = state.currentFoodUnits.find(u => u.id === selectedUnitId) || { factor: 1, id: 'g' };
    const amount = parseFloat(foodPortionAmount.value) || 1;
    const grams = Math.round((amount * unit.factor) * 10) / 10;
    const baseGrams = f.serving_grams || 100;
    const ratio = grams / baseGrams;

    const payload = {
      date: state.currentDate,
      meal_type: state.targetMealType,
      food_name: f.name,
      brand: f.brand || '',
      grams: grams,
      servings: amount,
      serving_unit: unit.id,
      calories: Math.round(f.calories * ratio),
      protein_g: Number((f.protein_g * ratio).toFixed(1)),
      carbs_g: Number((f.carbs_g * ratio).toFixed(1)),
      fat_g: Number((f.fat_g * ratio).toFixed(1)),
      sodium_mg: Math.round((f.sodium_mg || 0) * ratio),
      fiber_g: Number(((f.fiber_g || 0) * ratio).toFixed(1)),
      source: f.id && f.id.startsWith('off_') ? 'openfoodfacts' : 'usda'
    };

    try {
      const res = await apiFetch('/api/meals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        showToast(`Logged ${payload.food_name}!`);
        closeAddFoodModal();
        loadDayData();
      }
    } catch (err) {
      showToast('Error logging meal item');
    }
  });

  foodSearchInput.addEventListener('input', (e) => {
    clearTimeout(state.searchDebounceTimer);
    state.searchDebounceTimer = setTimeout(() => {
      triggerFoodSearch(e.target.value.trim());
    }, 280);
  });

  foodSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(state.searchDebounceTimer);
      triggerFoodSearch(foodSearchInput.value.trim());
    }
  });

  document.querySelectorAll('.meal-add-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const meal = btn.getAttribute('data-meal');
      openAddFoodModal(meal);
    });
  });

  document.getElementById('modal-close-add-food').addEventListener('click', closeAddFoodModal);

  // -------------------------------------------------------------
  // Quick Calorie Entry Modal
  // -------------------------------------------------------------
  const modalQuickCals = document.getElementById('modal-quick-cals');
  document.getElementById('quick-manual-cals-btn').addEventListener('click', () => {
    modalQuickCals.classList.add('active');
  });
  document.getElementById('modal-close-quick-cals').addEventListener('click', () => {
    modalQuickCals.classList.remove('active');
  });

  document.getElementById('submit-quick-cals-btn').addEventListener('click', async () => {
    const foodName = document.getElementById('quick-food-name').value.trim() || 'Quick Meal';
    const mealType = document.getElementById('quick-meal-type').value;
    const cals = parseFloat(document.getElementById('quick-cals-val').value) || 0;
    const pro = parseFloat(document.getElementById('quick-pro-val').value) || 0;
    const carbs = parseFloat(document.getElementById('quick-carb-val').value) || 0;
    const fat = parseFloat(document.getElementById('quick-fat-val').value) || 0;

    if (cals <= 0) {
      showToast('Please enter calorie count');
      return;
    }

    const payload = {
      date: state.currentDate,
      meal_type: mealType,
      food_name: foodName,
      calories: cals,
      protein_g: pro,
      carbs_g: carbs,
      fat_g: fat,
      source: 'manual'
    };

    try {
      const res = await apiFetch('/api/meals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        showToast('Logged meal!');
        modalQuickCals.classList.remove('active');
        document.getElementById('quick-food-name').value = '';
        document.getElementById('quick-cals-val').value = '';
        document.getElementById('quick-pro-val').value = '';
        document.getElementById('quick-carb-val').value = '';
        document.getElementById('quick-fat-val').value = '';
        loadDayData();
      }
    } catch (err) {
      showToast('Error saving entry');
    }
  });

  // -------------------------------------------------------------
  // AI Vision Plate Scanner
  // -------------------------------------------------------------
  const cameraInput = document.getElementById('camera-file-input');
  const galleryInput = document.getElementById('gallery-file-input');
  const previewImg = document.getElementById('scanned-image-preview');
  const camPlaceholder = document.getElementById('cam-placeholder');
  const startAiScanBtn = document.getElementById('start-ai-scan-btn');
  const scanLoadingIndicator = document.getElementById('scan-loading-indicator');
  const aiResultsContainer = document.getElementById('ai-results-container');
  let currentScannedBase64 = null;

  document.getElementById('jump-to-scanner-btn').addEventListener('click', () => switchTab('scanner'));
  document.getElementById('camera-dropzone').addEventListener('click', () => cameraInput.click());
  document.getElementById('trigger-camera-btn').addEventListener('click', () => cameraInput.click());
  document.getElementById('trigger-gallery-btn').addEventListener('click', () => galleryInput.click());

  cameraInput.addEventListener('change', handleImageUpload);
  galleryInput.addEventListener('change', handleImageUpload);

  function handleImageUpload(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      currentScannedBase64 = event.target.result;
      previewImg.src = currentScannedBase64;
      previewImg.style.display = 'block';
      camPlaceholder.style.display = 'none';
      startAiScanBtn.style.display = 'block';
      aiResultsContainer.style.display = 'none';
    };
    reader.readAsDataURL(file);
  }

  startAiScanBtn.addEventListener('click', async () => {
    if (!currentScannedBase64) {
      showToast('Please take or upload a food photo first');
      return;
    }

    startAiScanBtn.style.display = 'none';
    scanLoadingIndicator.style.display = 'block';
    aiResultsContainer.style.display = 'none';

    try {
      const res = await apiFetch('/api/ai/scan-plate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: currentScannedBase64 })
      });

      const data = await res.json();
      scanLoadingIndicator.style.display = 'none';

      if (!res.ok) {
        console.error('Scan error:', data);
        showToast(data.error || 'Gemini Vision scan failed', 5000);
        startAiScanBtn.style.display = 'block';
        return;
      }

      state.scannedAiResult = data;
      renderAiScanResults(data);
    } catch (err) {
      console.error('Gemini exception:', err);
      scanLoadingIndicator.style.display = 'none';
      startAiScanBtn.style.display = 'block';
      showToast('Error communicating with Gemini: ' + (err.message || ''), 4500);
    }
  });

  function renderAiScanResults(data) {
    document.getElementById('ai-plate-title').textContent = data.plate_summary || 'Plate Items';
    document.getElementById('ai-total-cals').textContent = `${data.total_calories || 0} kcal`;
    document.getElementById('ai-total-pro').textContent = `${data.total_protein_g || 0}g`;
    document.getElementById('ai-total-carb').textContent = `${data.total_carbs_g || 0}g`;
    document.getElementById('ai-total-fat').textContent = `${data.total_fat_g || 0}g`;

    const itemsContainer = document.getElementById('ai-items-list');
    itemsContainer.innerHTML = (data.items || []).map((item, idx) => `
      <div class="ai-item-card" data-idx="${idx}">
        <div class="ai-item-left">
          <div class="ai-item-title">${escapeHtml(item.food_name)}</div>
          <div class="ai-item-assumption">${escapeHtml(item.assumptions || 'Estimated in grams')}</div>
          <div style="font-size: 0.75rem; color: var(--cal-color); margin-top: 4px; font-weight: 600;">
            ${Math.round(item.calories)} kcal &bull; ${item.protein_g}g P &bull; ${item.carbs_g}g C &bull; ${item.fat_g}g F
          </div>
        </div>
        <div class="portion-adjuster">
          <input type="number" class="portion-grams-input" value="${item.estimated_grams || 100}" data-item-idx="${idx}">
          <span style="font-size: 0.72rem; color: var(--text-muted)">g</span>
        </div>
      </div>
    `).join('');

    aiResultsContainer.style.display = 'block';
    aiResultsContainer.scrollIntoView({ behavior: 'smooth' });

    itemsContainer.querySelectorAll('.portion-grams-input').forEach(input => {
      input.addEventListener('input', (e) => {
        const idx = parseInt(e.target.getAttribute('data-item-idx'));
        const newGrams = parseFloat(e.target.value) || 0;
        const item = state.scannedAiResult.items[idx];
        const oldGrams = item.estimated_grams || 100;
        if (oldGrams > 0) {
          const ratio = newGrams / oldGrams;
          item.calories = Math.round(item.calories * ratio);
          item.protein_g = Number((item.protein_g * ratio).toFixed(1));
          item.carbs_g = Number((item.carbs_g * ratio).toFixed(1));
          item.fat_g = Number((item.fat_g * ratio).toFixed(1));
          item.estimated_grams = newGrams;
        }
        recalcAiScanTotals();
      });
    });
  }

  function recalcAiScanTotals() {
    if (!state.scannedAiResult || !state.scannedAiResult.items) return;
    const items = state.scannedAiResult.items;
    let sumCal = 0, sumP = 0, sumC = 0, sumF = 0;
    items.forEach(it => {
      sumCal += it.calories;
      sumP += it.protein_g;
      sumC += it.carbs_g;
      sumF += it.fat_g;
    });
    document.getElementById('ai-total-cals').textContent = `${Math.round(sumCal)} kcal`;
    document.getElementById('ai-total-pro').textContent = `${Math.round(sumP)}g`;
    document.getElementById('ai-total-carb').textContent = `${Math.round(sumC)}g`;
    document.getElementById('ai-total-fat').textContent = `${Math.round(sumF)}g`;
  }

  document.getElementById('commit-ai-meal-btn').addEventListener('click', async () => {
    if (!state.scannedAiResult || !state.scannedAiResult.items) return;
    const mealType = document.getElementById('ai-target-meal-type').value;

    const payloadList = state.scannedAiResult.items.map(it => ({
      date: state.currentDate,
      meal_type: mealType,
      food_name: it.food_name,
      grams: it.estimated_grams || 100,
      calories: it.calories,
      protein_g: it.protein_g,
      carbs_g: it.carbs_g,
      fat_g: it.fat_g,
      sodium_mg: it.sodium_mg || 0,
      fiber_g: it.fiber_g || 0,
      source: 'ai_scan'
    }));

    try {
      const res = await apiFetch('/api/meals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadList)
      });
      if (res.ok) {
        showToast(`Logged ${payloadList.length} items to ${mealType}!`);
        switchTab('today');
        loadDayData();
      }
    } catch (err) {
      showToast('Error saving AI meal items');
    }
  });

  // -------------------------------------------------------------
  // Smart Recipe Engine (Uses permanent avoided ingredients)
  // -------------------------------------------------------------
  function updateRecipeRemainingContext() {
    const p = state.profile;
    const totals = state.dayData.totals;
    if (!p) return;

    const remCal = Math.max(0, p.target_calories - Math.round(totals.calories));
    const remP = Math.max(0, p.target_protein_g - Math.round(totals.protein_g));
    const remC = Math.max(0, p.target_carbs_g - Math.round(totals.carbs_g));
    const remF = Math.max(0, p.target_fat_g - Math.round(totals.fat_g));

    document.getElementById('recipe-rem-cal').textContent = remCal;
    document.getElementById('recipe-rem-pro').textContent = remP;
    document.getElementById('recipe-rem-carb').textContent = remC;
    document.getElementById('recipe-rem-fat').textContent = remF;

    // Display permanent avoided ingredients from Profile
    const avoided = p.ingredients_to_avoid || 'None configured';
    document.getElementById('recipe-avoided-badge').textContent = avoided;
  }

  document.getElementById('jump-to-profile-avoid-link').addEventListener('click', () => {
    switchTab('settings');
    document.getElementById('setting-avoided-ingredients').focus();
  });

  document.getElementById('generate-recipes-btn').addEventListener('click', async () => {
    const prompt = document.getElementById('recipe-user-prompt').value.trim();
    const loader = document.getElementById('recipe-loading-indicator');
    const grid = document.getElementById('recipes-results-grid');

    loader.style.display = 'block';
    grid.innerHTML = '';

    try {
      const res = await apiFetch('/api/ai/recipes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: state.currentDate,
          userPrompt: prompt
        })
      });

      const data = await res.json();
      loader.style.display = 'none';

      if (!res.ok) {
        console.error('Recipe error:', data);
        showToast(data.error || 'Failed to generate recipes', 5000);
        return;
      }

      renderRecipes(data.recipes || []);
    } catch (err) {
      console.error('Recipe exception:', err);
      loader.style.display = 'none';
      showToast('Recipe generator error: ' + (err.message || ''), 4500);
    }
  });

  function renderRecipes(recipes) {
    const grid = document.getElementById('recipes-results-grid');
    if (recipes.length === 0) {
      grid.innerHTML = '<div style="text-align: center; color: var(--text-muted);">No recipes generated</div>';
      return;
    }

    grid.innerHTML = recipes.map(r => `
      <div class="recipe-card">
        <div style="display: flex; justify-content: space-between; align-items: baseline;">
          <h4 class="recipe-title">${escapeHtml(r.title)}</h4>
          <span style="font-size: 0.75rem; font-weight: 700; color: var(--cal-color);">${r.prep_time_min} mins</span>
        </div>
        <p style="font-size: 0.82rem; color: var(--text-secondary);">${escapeHtml(r.description || '')}</p>

        <div class="recipe-macros-pill-bar">
          <span style="color: var(--cal-color)">${Math.round(r.calories)} kcal</span>
          <span style="color: var(--pro-color)">${Math.round(r.protein_g)}g Protein</span>
          <span style="color: var(--carb-color)">${Math.round(r.carbs_g)}g Carbs</span>
          <span style="color: var(--fat-color)">${Math.round(r.fat_g)}g Fat</span>
        </div>

        <div>
          <div style="font-size: 0.8rem; font-weight: 700; margin-bottom: 6px;">Ingredients (Metric):</div>
          <ul class="recipe-ingredients-list">
            ${(r.ingredients || []).map(i => `<li>${escapeHtml(i)}</li>`).join('')}
          </ul>
        </div>

        <div>
          <div style="font-size: 0.8rem; font-weight: 700; margin-bottom: 6px;">Instructions:</div>
          <ol class="recipe-steps-list">
            ${(r.instructions || []).map(s => `<li>${escapeHtml(s)}</li>`).join('')}
          </ol>
        </div>

        <button class="btn-primary log-recipe-btn" data-title="${escapeHtml(r.title)}" data-cal="${r.calories}" data-p="${r.protein_g}" data-c="${r.carbs_g}" data-f="${r.fat_g}" style="padding: 10px; font-size: 0.84rem; margin-top: 6px;">
          Log This Meal to Dinner
        </button>
      </div>
    `).join('');

    grid.querySelectorAll('.log-recipe-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const title = btn.getAttribute('data-title');
        const cal = parseFloat(btn.getAttribute('data-cal')) || 0;
        const p = parseFloat(btn.getAttribute('data-p')) || 0;
        const c = parseFloat(btn.getAttribute('data-c')) || 0;
        const f = parseFloat(btn.getAttribute('data-f')) || 0;

        try {
          const res = await apiFetch('/api/meals', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              date: state.currentDate,
              meal_type: 'dinner',
              food_name: title,
              calories: cal,
              protein_g: p,
              carbs_g: c,
              fat_g: f,
              source: 'recipe'
            })
          });
          if (res.ok) {
            showToast(`Logged "${title}" to Dinner!`);
            switchTab('today');
            loadDayData();
          }
        } catch (e) {
          showToast('Failed to log recipe');
        }
      });
    });
  }

  // -------------------------------------------------------------
  // Analytics & Adaptive Diet Coach (Metric kg)
  // -------------------------------------------------------------
  async function loadAnalytics() {
    try {
      const [analyticsRes, coachRes] = await Promise.all([
        apiFetch('/api/analytics?days=14'),
        apiFetch('/api/adaptive/check-in')
      ]);

      const analyticsData = await analyticsRes.json();
      const coachData = await coachRes.json();

      renderCoachCard(coachData);
      renderCharts(analyticsData.chartData || [], analyticsData.targets);
    } catch (err) {
      console.error(err);
    }
  }

  function renderCoachCard(data) {
    document.getElementById('coach-confidence-badge').textContent = data.confidence.split(' ')[0] + ' Confidence';
    document.getElementById('coach-recommendation-text').textContent = data.recommendation;
    document.getElementById('coach-true-tdee').textContent = `${data.trueTDEE} kcal`;

    const deltaSign = data.weightTrendDeltaKg > 0 ? '+' : '';
    document.getElementById('coach-weight-delta').textContent = `${deltaSign}${data.weightTrendDeltaKg} kg`;

    const applyBtn = document.getElementById('apply-coach-adjustment-btn');
    if (data.suggestedAdjustments && data.suggestedAdjustments.target_calories !== data.targets.target_calories) {
      applyBtn.textContent = `Apply Suggested Targets (${data.suggestedAdjustments.target_calories} kcal / ${data.suggestedAdjustments.target_protein_g}g P)`;
      applyBtn.style.display = 'block';
      applyBtn.onclick = async () => {
        try {
          const res = await apiFetch('/api/profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              target_calories: data.suggestedAdjustments.target_calories,
              target_protein_g: data.suggestedAdjustments.target_protein_g,
              target_carbs_g: data.suggestedAdjustments.target_carbs_g,
              target_fat_g: data.suggestedAdjustments.target_fat_g
            })
          });
          if (res.ok) {
            showToast('Adaptive targets applied successfully!');
            await loadProfile();
            loadDayData();
            loadAnalytics();
          }
        } catch (e) {
          showToast('Error updating targets');
        }
      };
    } else {
      applyBtn.style.display = 'none';
    }
  }

  function renderCharts(data, targets) {
    if (!data || data.length === 0) return;

    const past7 = data.slice(-7);
    const avgCal7 = Math.round(past7.reduce((s, d) => s + d.calories, 0) / 7);
    const avgPro7 = Math.round(past7.reduce((s, d) => s + d.protein_g, 0) / 7);
    const latestWeightObj = [...data].reverse().find(d => d.weight_kg !== null);

    document.getElementById('stat-avg-cals').textContent = avgCal7;
    document.getElementById('stat-avg-pro').textContent = `${avgPro7}g`;
    document.getElementById('stat-latest-weight').textContent = latestWeightObj ? `${latestWeightObj.weight_kg} kg` : '-- kg';

    renderCaloriesChart(data, targets.target_calories);
    renderWeightChart(data);
    renderSleepChart(data);
  }

  function renderCaloriesChart(data, targetCals) {
    const svg = document.getElementById('chart-cals-svg');
    const width = 500;
    const height = 160;
    const maxVal = Math.max(3400, targetCals + 600, ...data.map(d => d.calories));
    const barWidth = 24;
    const gap = (width - 40 - (data.length * barWidth)) / (data.length - 1);

    const targetY = height - 25 - ((targetCals / maxVal) * (height - 45));

    let html = `
      <line x1="20" y1="${targetY}" x2="${width - 10}" y2="${targetY}" stroke="rgba(56, 189, 248, 0.4)" stroke-dasharray="4" stroke-width="1.5" />
      <text x="${width - 80}" y="${targetY - 5}" fill="var(--cal-color)" font-size="10" font-weight="600">Goal: ${targetCals}</text>
    `;

    data.forEach((d, i) => {
      const x = 25 + i * (barWidth + gap);
      const barH = (d.calories / maxVal) * (height - 45);
      const y = height - 25 - barH;
      const dayLabel = d.date.split('-')[2];
      const isOver = d.calories > targetCals + 250;
      const fillColor = d.calories === 0 ? 'rgba(255,255,255,0.05)' : (isOver ? '#f43f5e' : 'var(--cal-color)');

      html += `
        <rect x="${x}" y="${y}" width="${barWidth}" height="${barH}" rx="4" fill="${fillColor}" opacity="0.85" />
        <text x="${x + barWidth / 2}" y="${height - 8}" fill="var(--text-muted)" font-size="10" text-anchor="middle">${dayLabel}</text>
      `;
    });

    svg.innerHTML = html;
  }

  function renderWeightChart(data) {
    const svg = document.getElementById('chart-weight-svg');
    const width = 500;
    const height = 160;
    const validWeights = data.filter(d => d.weight_kg !== null);
    const validBF = data.filter(d => d.body_fat_pct !== null);

    if (validWeights.length === 0) {
      svg.innerHTML = `
        <text x="250" y="75" fill="var(--text-muted)" font-size="12" text-anchor="middle">
          Scale weight & body fat will automatically display here
        </text>
        <text x="250" y="95" fill="rgba(255,255,255,0.3)" font-size="10" text-anchor="middle">
          Sync via Apple Health Shortcut or log weight in Profile
        </text>
      `;
      return;
    }

    // Single weigh-in entry display
    if (validWeights.length === 1) {
      const single = validWeights[0];
      const bfText = single.body_fat_pct !== null ? ` • ${single.body_fat_pct}% BF` : '';
      svg.innerHTML = `
        <defs>
          <radialGradient id="singleGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="#10b981" stop-opacity="0.3"/>
            <stop offset="100%" stop-color="#10b981" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <!-- Center highlight glow -->
        <circle cx="250" cy="65" r="40" fill="url(#singleGlow)" />
        <circle cx="250" cy="65" r="16" fill="rgba(16, 185, 129, 0.15)" stroke="#10b981" stroke-width="1.5" stroke-dasharray="3,3"/>
        <circle cx="250" cy="65" r="7" fill="#10b981" stroke="#07090e" stroke-width="2"/>
        
        <!-- Big Metric Label -->
        <text x="250" y="40" fill="#34d399" font-size="18" font-weight="800" text-anchor="middle" letter-spacing="-0.5">
          ${single.weight_kg} kg <tspan fill="#a78bfa" font-size="14" font-weight="700">${bfText}</tspan>
        </text>
        
        <!-- Date pill -->
        <rect x="180" y="98" width="140" height="22" rx="11" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>
        <text x="250" y="113" fill="var(--text-muted)" font-size="10" font-weight="600" text-anchor="middle">
          Logged on ${single.date}
        </text>
        
        <text x="250" y="142" fill="rgba(255,255,255,0.35)" font-size="9" text-anchor="middle">
          Trend progression line unlocks once additional days are synced
        </text>
      `;
      return;
    }

    // Multi-day progression (>= 2 entries)
    const minW = Math.min(...validWeights.map(d => d.weight_kg)) - 0.4;
    const maxW = Math.max(...validWeights.map(d => d.weight_kg)) + 0.4;
    const weightPoints = [];
    const bfPoints = [];

    const hasMultiBF = validBF.length >= 2;
    const minBF = hasMultiBF ? Math.min(...validBF.map(d => d.body_fat_pct)) - 0.5 : 0;
    const maxBF = hasMultiBF ? Math.max(...validBF.map(d => d.body_fat_pct)) + 0.5 : 1;

    data.forEach((d, i) => {
      const x = 35 + (i / (data.length - 1)) * (width - 70);
      if (d.weight_kg !== null) {
        const y = height - 35 - (((d.weight_kg - minW) / (maxW - minW || 1)) * (height - 65));
        weightPoints.push({ x, y, val: d.weight_kg, date: d.date, bf: d.body_fat_pct });
      }
      if (hasMultiBF && d.body_fat_pct !== null) {
        const yBF = height - 35 - (((d.body_fat_pct - minBF) / (maxBF - minBF || 1)) * (height - 65));
        bfPoints.push({ x, y: yBF, val: d.body_fat_pct });
      }
    });

    const weightPath = weightPoints.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
    const weightArea = weightPoints.length > 0 
      ? `M ${weightPoints[0].x} ${height - 25} L ` + weightPoints.map(p => `${p.x} ${p.y}`).join(' L ') + ` L ${weightPoints[weightPoints.length - 1].x} ${height - 25} Z`
      : '';

    let html = `
      <defs>
        <linearGradient id="weightGradArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#10b981" stop-opacity="0.3"/>
          <stop offset="100%" stop-color="#10b981" stop-opacity="0.0"/>
        </linearGradient>
      </defs>

      <!-- Legend -->
      <g opacity="0.9">
        <circle cx="160" cy="14" r="3.5" fill="#10b981" />
        <text x="170" y="17" fill="#ecfdf5" font-size="9" font-weight="600">Weight (kg)</text>
        ${validBF.length > 0 ? `
          <circle cx="280" cy="14" r="3.5" fill="#a78bfa" />
          <text x="290" y="17" fill="#f5f3ff" font-size="9" font-weight="600">Body Fat (%)</text>
        ` : ''}
      </g>

      <!-- Subtle Area fill -->
      ${weightArea ? `<path d="${weightArea}" fill="url(#weightGradArea)" />` : ''}

      <!-- Weight Curve -->
      <path d="${weightPath}" fill="none" stroke="#34d399" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
    `;

    // Body fat trend line if >= 2 entries
    if (bfPoints.length >= 2) {
      const bfPath = bfPoints.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
      html += `
        <path d="${bfPath}" fill="none" stroke="#a78bfa" stroke-width="2" stroke-dasharray="3,3" stroke-linecap="round" />
      `;
      bfPoints.forEach(p => {
        html += `
          <circle cx="${p.x}" cy="${p.y}" r="3" fill="#8b5cf6" stroke="#07090e" stroke-width="1.5" />
          <text x="${p.x}" y="${p.y + 11}" fill="#ddd6fe" font-size="8" font-weight="600" text-anchor="middle">${p.val}%</text>
        `;
      });
    }

    // Weight Points & Labels
    weightPoints.forEach(p => {
      html += `
        <circle cx="${p.x}" cy="${p.y}" r="4" fill="#10b981" stroke="#07090e" stroke-width="2" />
        <text x="${p.x}" y="${p.y - 7}" fill="#ecfdf5" font-size="9" font-weight="700" text-anchor="middle">${p.val}kg</text>
        <text x="${p.x}" y="${height - 10}" fill="var(--text-muted)" font-size="9" text-anchor="middle">${p.date.split('-')[2]}</text>
      `;
    });

    svg.innerHTML = html;
  }

  function renderSleepChart(data) {
    const svg = document.getElementById('chart-sleep-svg');
    const width = 500;
    const height = 140;
    const validSleep = data.filter(d => d.sleep_hours !== null && d.sleep_hours > 0);

    if (validSleep.length === 0) {
      svg.innerHTML = `
        <text x="250" y="70" fill="var(--text-muted)" font-size="12" text-anchor="middle">
          Apple Health sleep data will automatically display here
        </text>
        <text x="250" y="90" fill="rgba(255,255,255,0.3)" font-size="10" text-anchor="middle">
          Syncs nightly hours from Apple Health / Apple Watch / Smart Ring
        </text>
      `;
      return;
    }

    const barW = 20;
    const gap = (width - 40 - (data.length * barW)) / (data.length - 1);
    const maxSleep = Math.max(9, ...data.map(d => d.sleep_hours || 0));

    // Optimal 7h sleep guide line
    const target7H_Y = height - 25 - ((7 / maxSleep) * (height - 45));

    let html = `
      <line x1="20" y1="${target7H_Y}" x2="${width - 15}" y2="${target7H_Y}" stroke="rgba(56, 189, 248, 0.25)" stroke-dasharray="3,3" stroke-width="1" />
      <text x="${width - 20}" y="${target7H_Y - 4}" fill="rgba(56, 189, 248, 0.6)" font-size="8.5" font-weight="600" text-anchor="end">Optimal 7h</text>
    `;

    data.forEach((d, i) => {
      const x = 25 + i * (barW + gap);
      const hrs = d.sleep_hours || 0;
      const barH = (hrs / maxSleep) * (height - 45);
      const y = height - 25 - barH;
      const col = hrs >= 7 ? 'var(--cal-color)' : (hrs > 0 ? '#fbbf24' : 'rgba(255,255,255,0.05)');

      html += `
        <rect x="${x}" y="${y}" width="${barW}" height="${barH}" rx="3" fill="${col}" opacity="0.85" />
        ${hrs > 0 ? `<text x="${x + barW / 2}" y="${Math.max(12, y - 4)}" fill="${hrs >= 7 ? '#38bdf8' : '#fbbf24'}" font-size="8.5" font-weight="700" text-anchor="middle">${hrs}h</text>` : ''}
        <text x="${x + barW / 2}" y="${height - 8}" fill="var(--text-muted)" font-size="9" text-anchor="middle">${d.date.split('-')[2]}</text>
      `;
    });

    svg.innerHTML = html;
  }

  // -------------------------------------------------------------
  // Settings & Profile Form (Metric kg, cm)
  // -------------------------------------------------------------
  function renderProfileForm() {
    const p = state.profile;
    if (!p) return;

    document.getElementById('setting-name').value = p.name || 'David';
    document.getElementById('setting-age').value = p.age || 28;
    document.getElementById('setting-sex').value = p.sex || 'male';
    document.getElementById('setting-height').value = p.height_cm || 178;
    document.getElementById('setting-weight').value = p.weight_kg || 78.0;
    document.getElementById('setting-body-fat').value = p.body_fat_pct !== undefined ? p.body_fat_pct : 15.0;
    document.getElementById('setting-activity').value = p.activity_level || 'moderate';
    document.getElementById('setting-goal').value = p.goal_type || 'lean_bulk';
    document.getElementById('setting-rate').value = p.commitment_rate !== undefined ? p.commitment_rate : 250;
    document.getElementById('setting-avoided-ingredients').value = p.ingredients_to_avoid || 'cilantro, mushrooms';

    const geminiInput = document.getElementById('setting-gemini-key');
    geminiInput.value = '';
    if (p.has_gemini_key) {
      geminiInput.placeholder = '•••••••••••••••• (API Key Active & Encrypted)';
    } else {
      geminiInput.placeholder = 'AIzaSy... (Paste key to activate)';
    }

    let customCal = '';
    if (p.custom_target_calories) customCal = p.custom_target_calories;
    else if (p.dietary_preferences) {
      try {
        const dp = typeof p.dietary_preferences === 'string' ? JSON.parse(p.dietary_preferences) : p.dietary_preferences;
        if (dp && dp.custom_target_calories) customCal = dp.custom_target_calories;
      } catch (e) {}
    }
    const customCalInput = document.getElementById('setting-custom-cals');
    if (customCalInput) customCalInput.value = customCal || '';

    document.getElementById('webhook-token-display').value = p.webhook_token || '';
    const currentOrigin = window.location.origin;
    document.getElementById('webhook-url-display').value = `${currentOrigin}/api/health/sync`;
  }

  function renderCalculatedTargets() {
    const p = state.profile;
    if (!p) return;

    document.getElementById('calc-formula-display').textContent = p.calculation_formula || 'Katch-McArdle (Scale Body Fat)';
    document.getElementById('calc-bmr-display').textContent = p.bmr || '--';
    document.getElementById('calc-tdee-display').textContent = p.tdee || '--';
    document.getElementById('calc-target-cals-display').textContent = p.target_calories || '--';
    document.getElementById('calc-macro-split-display').textContent = `${p.target_protein_g}P / ${p.target_carbs_g}C / ${p.target_fat_g}F`;
    document.getElementById('calc-lean-mass-display').textContent = `${p.lean_mass_kg || '--'} kg`;
    document.getElementById('calc-bmi-display').textContent = p.bmi || '--';
  }

  document.getElementById('save-profile-btn').addEventListener('click', async () => {
    const customCalVal = document.getElementById('setting-custom-cals') ? document.getElementById('setting-custom-cals').value.trim() : '';
    const payload = {
      name: document.getElementById('setting-name').value.trim(),
      age: parseInt(document.getElementById('setting-age').value),
      sex: document.getElementById('setting-sex').value,
      height_cm: parseFloat(document.getElementById('setting-height').value),
      weight_kg: parseFloat(document.getElementById('setting-weight').value),
      body_fat_pct: parseFloat(document.getElementById('setting-body-fat').value),
      activity_level: document.getElementById('setting-activity').value,
      goal_type: document.getElementById('setting-goal').value,
      commitment_rate: parseFloat(document.getElementById('setting-rate').value),
      ingredients_to_avoid: document.getElementById('setting-avoided-ingredients').value.trim(),
      dietary_preferences: {
        style: 'high_protein_bulk',
        custom_target_calories: customCalVal ? parseFloat(customCalVal) : null
      }
    };

    try {
      const res = await apiFetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        state.profile = await res.json();
        renderCalculatedTargets();
        renderTodayView();
        updateRecipeRemainingContext();
        showToast('Profile updated (Metric) & targets recalculated!');
      }
    } catch (err) {
      showToast('Error saving profile');
    }
  });

  document.getElementById('save-gemini-key-btn').addEventListener('click', async () => {
    const key = document.getElementById('setting-gemini-key').value.trim();
    if (!key) {
      showToast('Please enter an API key');
      return;
    }
    try {
      const res = await apiFetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gemini_api_key: key })
      });
      if (res.ok) {
        showToast('Gemini API key encrypted & saved safely!');
        document.getElementById('setting-gemini-key').value = '';
        document.getElementById('setting-gemini-key').placeholder = '•••••••••••••••• (API Key Active & Encrypted)';
        await loadProfile();
      }
    } catch (e) {
      showToast('Error saving key');
    }
  });

  const testKeyBtn = document.getElementById('test-gemini-key-btn');
  if (testKeyBtn) {
    testKeyBtn.addEventListener('click', async () => {
      testKeyBtn.disabled = true;
      testKeyBtn.textContent = 'Testing...';
      try {
        const res = await apiFetch('/api/ai/test');
        const data = await res.json();
        testKeyBtn.disabled = false;
        testKeyBtn.textContent = '⚡ Test Connection';
        if (res.ok && data.success) {
          showToast(`✓ Gemini Connected! Using: ${data.activeModel} (${data.availableCount} models found)`, 5000);
        } else {
          showToast(`✕ Error: ${data.error || 'Connection failed'}`, 6000);
        }
      } catch (err) {
        testKeyBtn.disabled = false;
        testKeyBtn.textContent = '⚡ Test Connection';
        showToast('Error testing connection: ' + err.message, 5000);
      }
    });
  }

  document.getElementById('copy-webhook-url-btn').addEventListener('click', () => {
    const val = document.getElementById('webhook-url-display').value;
    navigator.clipboard.writeText(val);
    showToast('Webhook URL copied!');
  });

  document.getElementById('copy-webhook-token-btn').addEventListener('click', () => {
    const val = document.getElementById('webhook-token-display').value;
    navigator.clipboard.writeText(val);
    showToast('Token copied!');
  });

  // -------------------------------------------------------------
  // Scale & Apple Health Sync Modal (Metric kg)
  // -------------------------------------------------------------
  const modalScaleSync = document.getElementById('modal-scale-sync');
  document.getElementById('quick-scale-sync-btn').addEventListener('click', openScaleSyncModal);
  document.getElementById('test-health-sync-btn').addEventListener('click', openScaleSyncModal);
  document.getElementById('modal-close-scale-sync').addEventListener('click', () => {
    modalScaleSync.classList.remove('active');
  });

  function openScaleSyncModal() {
    const p = state.profile;
    const h = state.dayData.health;
    document.getElementById('modal-scale-weight').value = (h && h.weight_kg) || (p && p.weight_kg) || 78.0;
    document.getElementById('modal-scale-fat').value = (h && h.body_fat_pct) || (p && p.body_fat_pct) || 15.0;
    document.getElementById('modal-scale-bmi').value = (h && h.bmi) || 24.6;
    document.getElementById('modal-scale-sleep').value = (h && h.sleep_hours) || 8.0;
    modalScaleSync.classList.add('active');
  }

  document.getElementById('submit-scale-sync-btn').addEventListener('click', async () => {
    const weight = parseFloat(document.getElementById('modal-scale-weight').value);
    const fat = parseFloat(document.getElementById('modal-scale-fat').value);
    const bmi = parseFloat(document.getElementById('modal-scale-bmi').value);
    const sleep = parseFloat(document.getElementById('modal-scale-sleep').value);
    const token = state.profile && state.profile.webhook_token;

    try {
      const res = await apiFetch('/api/health/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          date: state.currentDate,
          weight_kg: weight,
          body_fat_pct: fat,
          bmi,
          sleep_hours: sleep
        })
      });

      if (res.ok) {
        showToast('Scale & Health data synced (Metric)!');
        modalScaleSync.classList.remove('active');
        await loadProfile();
        loadDayData();
      }
    } catch (e) {
      showToast('Error syncing scale metrics');
    }
  });

  // -------------------------------------------------------------
  // Date Navigation
  // -------------------------------------------------------------
  document.getElementById('prev-date-btn').addEventListener('click', () => shiftDate(-1));
  document.getElementById('next-date-btn').addEventListener('click', () => shiftDate(1));
  document.getElementById('current-date-label').addEventListener('click', () => {
    state.currentDate = getLocalDateString(new Date());
    loadDayData();
  });

  function shiftDate(deltaDays) {
    const parts = state.currentDate.split('-');
    const cur = new Date(parts[0], parts[1] - 1, parts[2]);
    cur.setDate(cur.getDate() + deltaDays);
    state.currentDate = getLocalDateString(cur);
    loadDayData();
  }

  // -------------------------------------------------------------
  // Tab Navigation
  // -------------------------------------------------------------
  function switchTab(tabId) {
    state.activeTab = tabId;

    document.querySelectorAll('.view-panel').forEach(panel => {
      panel.classList.remove('active');
    });
    const targetPanel = document.getElementById(`view-${tabId}`);
    if (targetPanel) targetPanel.classList.add('active');

    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
    });

    if (tabId === 'analytics') {
      loadAnalytics();
    } else if (tabId === 'recipes') {
      updateRecipeRemainingContext();
    }
  }

  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');
      switchTab(tab);
    });
  });

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Initial Load
  loadProfile().then(() => {
    loadDayData();
  });
});
