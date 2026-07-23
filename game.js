// ============================================================================
// game.js  —  OYUNNANIS (tamamen frontend). Blockchain HICBIR oyun mantigi bilmez.
// ============================================================================
// Bu sinif: arka plan, dusman, kule, mermi, senaryo (gece/gunduz/yaz/kis),
// hizlandirma, ikinci kule ekleme, upgrade modal'i. Hepsi browser'da.
// Ekonomi/permission/fiyat -> contract (Chain + ui.js). Oyunnanis karari -> burada.
// ============================================================================

window.GAME = (function () {
  "use strict";

  const cfg = window.ARC_CONFIG;
  const GP = cfg.GAMEPLAY;

  const state = {
    canvas: null, ctx: null,
    running: false, raf: null, lastT: 0,
    speed: 1,                 // 1x / 2x / 3x
    scenarioIndex: 0,
    lives: 20, maxLives: 20,
    coins: 150, startingCoins: 150,
    joined: false,
    entryFeeUSDC: 0,
    enemyMultiplier: 1.0,
    features: {},
    shopItems: [],
    towers: [], enemies: [], projectiles: [], particles: [],
    wave: 1, spawnTimer: 0,
    selectedTower: null,      // upgrade icin secili kule
    gameTime: 0,              // senaryo dongusu icin
    ownedTowerItems: new Set(), // contract ownsItem'dan gelen kule item id'leri
  };

  // Kule tipleri (frontend gameplay). Contract'tan GELMEZ (gameplay).
  // "unlock" durumu contract item ownership (ownsItem) ile kontrol edilir.
  // TOWER_ITEM_IDS: her kule tipinin contract'taki ilgili item id'si.
  // (Owner, category="tower" olan item'lari ekler; frontend sadece sahipligi okur.)
  const TOWER_TYPES = {
    archer:  { name: "Okçu Kulesi",  range: 160, dmg: 18, rate: 0.8, color: "#7c5cff", proj: "arrow",  cost: 50, itemId: 1 },
    cannon:  { name: "Top Kulesi",   range: 130, dmg: 40, rate: 1.6, color: "#d2691e", proj: "cannon", cost: 120, itemId: 2 },
    frost:   { name: "Buz Kulesi",   range: 140, dmg: 12, rate: 1.0, color: "#4fc3f7", proj: "ice",    cost: 90, itemId: 3 },
    flame:   { name: "Ateş Kulesi",  range: 150, dmg: 22, rate: 0.9, color: "#ff7043", proj: "fire",   cost: 100, itemId: 4 },
    missile: { name: "Füze Kulesi",  range: 220, dmg: 60, rate: 2.2, color: "#ef5350", proj: "missile",cost: 200, itemId: 5 },
  };

  const PROJECTILE = {
    arrow:   { speed: 420, color: "#fff", radius: 3 },
    cannon:  { speed: 260, color: "#444", radius: 6 },
    ice:     { speed: 380, color: "#b3e5fc", radius: 4, slow: 0.5 },
    fire:    { speed: 400, color: "#ffab40", radius: 4, burn: 2 },
    missile: { speed: 320, color: "#ff1744", radius: 5, splash: 40 },
  };

  // Yol noktalari (soldan saga egri)
  const PATH = [
    { x: -40, y: 430 }, { x: 140, y: 430 }, { x: 220, y: 330 },
    { x: 360, y: 300 }, { x: 440, y: 200 }, { x: 620, y: 220 },
    { x: 700, y: 340 }, { x: 860, y: 360 }, { x: 1000, y: 360 },
  ];

  function init() {
    state.canvas = document.getElementById("game");
    state.ctx = state.canvas.getContext("2d");
    // Fallback degerler; gercek degerler contract'tan (ui.js syncFromContract) gelir:
    // StartingCoins -> coins, MaxLives -> maxLives, EnemyMultiplier -> enemyMultiplier
    state.maxLives = cfg.GAMEPLAY.startingLivesFallback || 20;
    state.lives = state.maxLives;
    state.startingCoins = cfg.GAMEPLAY.startingCoinsFallback || 150;
    state.coins = state.startingCoins;
    bindUI();
    requestAnimationFrame(loop);
    updateHUD();
  }

  // Cuzdan degisince / yenile baglaninca oyun state'ini sifirla (yeni oyuncu = yeni oyun)
  function resetForNewWallet() {
    state.joined = false;
    state.running = false;
    state.towers = [];
    state.enemies = [];
    state.projectiles = [];
    state.particles = [];
    state.wave = 1;
    state.selectedTower = null;
    state.coins = state.startingCoins;
    state.lives = state.maxLives;
    state.ownedTowerItems = new Set();
    updateHUD();
  }

  function bindUI() {
    document.getElementById("join-btn").onclick = () => GameUI.joinGame();
    document.getElementById("add-tower-btn").onclick = () => openAddTowerModal();
    document.getElementById("upgrade-btn").onclick = () => openUpgradeModal();
    document.getElementById("speed-btn").onclick = cycleSpeed;
    document.getElementById("scenario-btn").onclick = cycleScenario;
    document.getElementById("connect-btn").onclick = () => {
      if (WALLET_STATE.connected) { window.Wallet.disconnect(); }
      else { GameUI.showWalletPicker(); }
    };
    // Add tower modal
    document.getElementById("add-confirm").onclick = confirmAddTower;
    document.getElementById("add-cancel").onclick = () => GameUI.closeModal("add-modal");
    // Upgrade modal
    document.getElementById("up-confirm").onclick = confirmUpgrade;
    document.getElementById("up-cancel").onclick = () => GameUI.closeModal("upgrade-modal");
    // Game over / restart modal
    const goRestart = document.getElementById("gameover-restart");
    if (goRestart) goRestart.onclick = () => window.GAME.restartGame();
    const goClose = document.getElementById("gameover-close");
    if (goClose) goClose.onclick = () => GameUI.closeModal("gameover-modal");
    // Canvas click -> kule sec / yerlestir
    state.canvas.addEventListener("click", onCanvasClick);
  }

  function onCanvasClick(e) {
    const r = state.canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) * (state.canvas.width / r.width);
    const y = (e.clientY - r.top) * (state.canvas.height / r.height);
    // Onceden yerlestirilmis kuleye tiklandiysa sec
    for (const t of state.towers) {
      if (Math.hypot(t.x - x, t.y - y) < 26) {
        state.selectedTower = t;
        document.getElementById("upgrade-btn").disabled = false;
        return;
      }
    }
    // Bos yere tiklanirsa ekleme modu actik (eger yerlestirme bekleniyorsa)
    if (state.pendingPlace) {
      placeTower(x, y, state.pendingPlace);
      state.pendingPlace = null;
    }
  }

  // ---------------- Add Tower Modal ----------------
  function openAddTowerModal() {
    const grid = document.getElementById("add-tower-grid");
    if (grid) grid.replaceChildren();           // XSS-safe clear
    Object.keys(TOWER_TYPES).forEach((key) => {
      const t = TOWER_TYPES[key];
      const owned = isUnlocked(key);
      const card = document.createElement("div");
      card.className = "tower-card" + (owned ? "" : " locked");
      const icon = document.createElement("div");
      icon.className = "tower-icon";
      icon.style.background = t.color;
      const name = document.createElement("div");
      name.textContent = t.name;
      const cost = document.createElement("div");
      cost.className = "muted";
      cost.textContent = t.cost + " coin";
      card.append(icon, name, cost);
      if (!owned) {
        const lock = document.createElement("div");
        lock.className = "muted";
        lock.textContent = "🔒 contract'tan satın al";
        card.appendChild(lock);
      }
      if (owned) card.onclick = () => { state.pendingPlace = key; GameUI.closeModal("add-modal"); showNotification("Haritada boş yere tıkla", "info"); };
      grid.appendChild(card);
    });
    GameUI.openModal("add-modal");
  }

  // contract item ownership'e gore kilavuz: archer her zaman acik (itemId 1,
  // base kule); digerleri icin Chain uzerinden ownsItem(addr, itemId) sorgulanir.
  // Sahiplik bilgisi GAME.ownedTowerItemIds Set'i ui.js tarafindan doldurulur.
  function isUnlocked(towerKey) {
    if (towerKey === "archer") return true;
    const itemId = TOWER_TYPES[towerKey].itemId;
    return !!state.ownedTowerItems && state.ownedTowerItems.has(itemId);
  }

  function placeTower(x, y, key) {
    const t = TOWER_TYPES[key];
    if (state.coins < t.cost) { showNotification("Yetersiz coin", "warn"); return; }
    state.coins -= t.cost;
    state.towers.push({
      key, x, y, type: t, level: 1,
      cooldown: 0, dmg: t.dmg, range: t.range, rate: t.rate,
      color: t.color, proj: t.proj,
    });
    updateHUD();
    showNotification(t.name + " eklendi", "success");
  }

  function confirmAddTower() { GameUI.closeModal("add-modal"); }

  // ---------------- Upgrade Modal ----------------
  function openUpgradeModal() {
    const t = state.selectedTower;
    if (!t) { showNotification("Önce bir kule seç", "warn"); return; }
    const nextCost = upgradeCost(t);
    document.getElementById("up-title").textContent = t.type.name + " (Seviye " + t.level + ")";
    const body = document.getElementById("up-body");
    if (body) body.replaceChildren();            // XSS-safe clear
    const p1 = document.createElement("p"); p1.textContent = "Mevcut hasar: " + Math.round(t.dmg);
    const p2 = document.createElement("p"); p2.textContent = "Menzil: " + Math.round(t.range) + " · Atış hızı: " + t.rate.toFixed(1) + "s";
    const p3 = document.createElement("p"); p3.textContent = "Yükseltme maliyeti: " + nextCost + " coin";
    if (body) body.append(p1, p2, p3);
    document.getElementById("up-confirm").disabled = state.coins < nextCost;
    GameUI.openModal("upgrade-modal");
  }

  function upgradeCost(t) { return Math.round(t.type.cost * 0.6 * t.level); }

  function confirmUpgrade() {
    const t = state.selectedTower;
    if (!t) return;
    const cost = upgradeCost(t);
    if (state.coins < cost) { showNotification("Yetersiz coin", "warn"); return; }
    state.coins -= cost;
    t.level++;
    t.dmg *= 1.35;
    t.range *= 1.08;
    t.rate *= 0.92;
    updateHUD();
    GameUI.closeModal("upgrade-modal");
    showNotification("Yükseltildi → Seviye " + t.level, "success");
  }

  // ---------------- Speed ----------------
  function cycleSpeed() {
    const idx = cfg.SPEEDS.indexOf(state.speed);
    state.speed = cfg.SPEEDS[(idx + 1) % cfg.SPEEDS.length];
    document.getElementById("speed-btn").textContent = "Hız: " + state.speed + "x";
    showNotification("Oyun hızı: " + state.speed + "x", "info");
  }

  // ---------------- Scenario ----------------
  function cycleScenario() {
    state.scenarioIndex = (state.scenarioIndex + 1) % cfg.SCENARIOS.length;
    updateHUD();
    showNotification("Senaryo: " + cfg.SCENARIOS[state.scenarioIndex].name, "info");
  }

  // ---------------- Loop ----------------
  function loop(t) {
    const dt = state.lastT ? Math.min((t - state.lastT) / 1000, 0.05) : 0;
    state.lastT = t;
    if (state.running) update(dt * state.speed);
    render();
    state.raf = requestAnimationFrame(loop);
  }

  function start() {
    if (state.running) return;
    state.running = true;
    showNotification("Oyun başladı", "success");
  }

  // ---------------- Game Over + Restart ----------------
  function gameOver() {
    showNotification("Oyun bitti!", "error");
    // Restart modalini goster (index.html'de #gameover-modal var)
    const score = state.wave;
    const el = document.getElementById("gameover-wave");
    if (el) el.textContent = "Ulaşılan dalga: " + state.wave;
    const mb = document.getElementById("gameover-modal");
    if (mb) mb.classList.add("open");
  }

  function restartGame() {
    // State'i sifirla (cuzdan bagli kalir, sadece oyun iciv state)
    state.towers = [];
    state.enemies = [];
    state.projectiles = [];
    state.particles = [];
    state.wave = 1;
    state.selectedTower = null;
    state.coins = state.startingCoins;
    state.lives = state.maxLives;
    state.gameTime = 0;
    GameUI.closeModal("gameover-modal");
    updateHUD();
    start();
    showNotification("Yeniden başlatıldı!", "success");
  }

  function update(dt) {
    state.gameTime += dt;
    // Spawn
    state.spawnTimer -= dt;
    if (state.spawnTimer <= 0 && state.enemies.length < GP.waveEnemyCount) {
      spawnEnemy();
      state.spawnTimer = GP.spawnInterval / state.enemyMultiplier;
    }
    // Enemies
    for (const en of state.enemies) {
      en.dist += GP.pathSpeed * en.speed * dt;
      const pos = pathAt(en.dist);
      en.x = pos.x; en.y = pos.y;
      // burn / slow effect timers
      if (en.burn > 0) { en.burn -= dt; en.hp -= 4 * dt; }
      if (en.slow > 0) en.slow -= dt;
      if (en.hp <= 0) { en.dead = true; state.coins += 8; }
      if (en.dist >= pathLength()) { en.reached = true; state.lives--; }
    }
    // Towers fire
    for (const tw of state.towers) {
      tw.cooldown -= dt;
      if (tw.cooldown <= 0) {
        const target = nearestEnemy(tw);
        if (target) {
          fire(tw, target);
          tw.cooldown = tw.rate;
        }
      }
    }
    // Projectiles
    for (const p of state.projectiles) {
      const dx = p.tx - p.x, dy = p.ty - p.y;
      const d = Math.hypot(dx, dy);
      const step = PROJECTILE[p.kind].speed * dt;
      if (d <= step) { hit(p); p.dead = true; }
      else { p.x += dx / d * step; p.y += dy / d * step; }
    }
    // Particles
    for (const pt of state.particles) { pt.life -= dt; pt.x += pt.vx * dt; pt.y += pt.vy * dt; }

    // cleanup
    state.enemies = state.enemies.filter((e) => !e.dead && !e.reached);
    state.projectiles = state.projectiles.filter((p) => !p.dead);
    state.particles = state.particles.filter((p) => p.life > 0);

    if (state.lives <= 0 && state.running) {
      state.running = false;
      gameOver();
    }
    updateHUD();
  }

  function spawnEnemy() {
    const mul = state.enemyMultiplier || 1;
    state.enemies.push({
      dist: 0, hp: 50 * mul, maxhp: 50 * mul, speed: 0.8 + Math.random() * 0.4,
      x: PATH[0].x, y: PATH[0].y, burn: 0, slow: 0,
    });
  }

  function nearestEnemy(tw) {
    let best = null, bd = tw.range;
    for (const e of state.enemies) {
      const d = Math.hypot(e.x - tw.x, e.y - tw.y);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  function fire(tw, target) {
    state.projectiles.push({
      x: tw.x, y: tw.y, tx: target.x, ty: target.y,
      kind: tw.proj, dmg: tw.dmg, target, dead: false,
    });
  }

  function hit(p) {
    const pr = PROJECTILE[p.kind];
    if (pr.splash) {
      for (const e of state.enemies) {
        if (Math.hypot(e.x - p.tx, e.y - p.ty) < pr.splash) e.hp -= p.dmg;
      }
    } else if (p.target && !p.target.dead) {
      p.target.hp -= p.dmg;
      if (pr.slow) p.target.slow = 1.5;
      if (pr.burn) p.target.burn = 1.5;
    }
    // particle
    for (let i = 0; i < 6; i++) {
      state.particles.push({ x: p.tx, y: p.ty, vx: (Math.random() - 0.5) * 80, vy: (Math.random() - 0.5) * 80, life: 0.4, color: pr.color });
    }
  }

  function pathLength() {
    let L = 0;
    for (let i = 1; i < PATH.length; i++) L += Math.hypot(PATH[i].x - PATH[i - 1].x, PATH[i].y - PATH[i - 1].y);
    return L;
  }
  function pathAt(dist) {
    let d = dist;
    for (let i = 1; i < PATH.length; i++) {
      const seg = Math.hypot(PATH[i].x - PATH[i - 1].x, PATH[i].y - PATH[i - 1].y);
      if (d <= seg) {
        const t = d / seg;
        return { x: PATH[i - 1].x + (PATH[i].x - PATH[i - 1].x) * t, y: PATH[i - 1].y + (PATH[i].y - PATH[i - 1].y) * t };
      }
      d -= seg;
    }
    return PATH[PATH.length - 1];
  }

  // ---------------- Render (gelismis arka plan + senaryo) ----------------
  function render() {
    const ctx = state.ctx;
    const sc = cfg.SCENARIOS[state.scenarioIndex];
    drawBackground(ctx, sc);
    drawPath(ctx);
    // towers
    for (const tw of state.towers) drawTower(ctx, tw);
    // enemies
    for (const e of state.enemies) drawEnemy(ctx, e);
    // projectiles
    for (const p of state.projectiles) drawProjectile(ctx, p);
    // particles
    for (const pt of state.particles) {
      ctx.globalAlpha = Math.max(0, pt.life / 0.4);
      ctx.fillStyle = pt.color;
      ctx.fillRect(pt.x - 2, pt.y - 2, 4, 4);
    }
    ctx.globalAlpha = 1;
  }

  function drawBackground(ctx, sc) {
    const w = state.canvas.width, h = state.canvas.height;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, sc.sky[0]); g.addColorStop(1, sc.sky[1]);
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    // sun / moon
    ctx.fillStyle = sc.sun;
    ctx.beginPath();
    if (sc.night) { ctx.arc(w - 90, 80, 34, 0, Math.PI * 2); ctx.fill(); }
    else {
      ctx.arc(w - 90, 80, 40, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(255,240,160,0.25)";
      ctx.beginPath(); ctx.arc(w - 90, 80, 60, 0, Math.PI * 2); ctx.fill();
    }
    // stars at night
    if (sc.night) {
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      for (let i = 0; i < 40; i++) {
        const x = (i * 137.5) % w, y = (i * 89.3) % 200;
        ctx.fillRect(x, y, 2, 2);
      }
    }
    // ground
    ctx.fillStyle = sc.ground;
    ctx.fillRect(0, h - 90, w, 90);
    // snow
    if (sc.snow) {
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      const t = state.gameTime * 30;
      for (let i = 0; i < 80; i++) {
        const x = (i * 53 + t) % w;
        const y = (i * 97 + t * 1.3) % h;
        ctx.fillRect(x, y, 3, 3);
      }
    }
    // distant hills
    ctx.fillStyle = sc.night ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.10)";
    ctx.beginPath(); ctx.moveTo(0, h - 90);
    for (let x = 0; x <= w; x += 60) ctx.lineTo(x, h - 90 - 30 * Math.sin(x / 120));
    ctx.lineTo(w, h - 90); ctx.fill();
  }

  function drawPath(ctx) {
    ctx.strokeStyle = "rgba(120,90,60,0.9)";
    ctx.lineWidth = 26; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(PATH[0].x, PATH[0].y);
    for (let i = 1; i < PATH.length; i++) ctx.lineTo(PATH[i].x, PATH[i].y);
    ctx.stroke();
    ctx.strokeStyle = "rgba(180,150,110,0.6)"; ctx.lineWidth = 14;
    ctx.stroke();
  }

  function drawTower(ctx, tw) {
    ctx.fillStyle = tw.color;
    ctx.beginPath(); ctx.arc(tw.x, tw.y, 18, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.font = "bold 12px sans-serif";
    ctx.textAlign = "center"; ctx.fillText(tw.level, tw.x, tw.y + 4);
    // range (selected)
    if (state.selectedTower === tw) {
      ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(tw.x, tw.y, tw.range, 0, Math.PI * 2); ctx.stroke();
    }
  }

  function drawEnemy(ctx, e) {
    const r = 12;
    ctx.fillStyle = e.slow > 0 ? "#90caf9" : (e.burn > 0 ? "#ff7043" : "#e53935");
    ctx.beginPath(); ctx.arc(e.x, e.y, r, 0, Math.PI * 2); ctx.fill();
    // hp bar
    ctx.fillStyle = "#000"; ctx.fillRect(e.x - 14, e.y - 20, 28, 4);
    ctx.fillStyle = "#4caf50"; ctx.fillRect(e.x - 14, e.y - 20, 28 * (e.hp / e.maxhp), 4);
  }

  function drawProjectile(ctx, p) {
    const pr = PROJECTILE[p.kind];
    ctx.fillStyle = pr.color;
    if (p.kind === "arrow" || p.kind === "fire" || p.kind === "ice") {
      ctx.beginPath(); ctx.arc(p.x, p.y, pr.radius, 0, Math.PI * 2); ctx.fill();
    } else if (p.kind === "cannon") {
      ctx.beginPath(); ctx.arc(p.x, p.y, pr.radius, 0, Math.PI * 2); ctx.fill();
    } else if (p.kind === "missile") {
      ctx.fillStyle = "#ff1744"; ctx.fillRect(p.x - 3, p.y - 6, 6, 12);
    }
  }

  // ---------------- HUD ----------------
  function updateHUD() {
    document.getElementById("hud-lives").textContent = state.lives + " / " + state.maxLives;
    document.getElementById("hud-coins").textContent = state.coins;
    document.getElementById("hud-wave").textContent = state.wave;
    document.getElementById("hud-scenario").textContent = cfg.SCENARIOS[state.scenarioIndex].name;
  }
  // ui.js bunu cagirir (ayni isim alias)
  function refreshHUD() { updateHUD(); }

  // ---------------- Contract item -> gameplay uygulamasi ----------------
  function applyItemToGameplay(item) {
    // Frontend karari: item.category'ye gore oyuna etki.
    const cat = item.category || "misc";
    if (cat === "boost") { state.coins += 25; showNotification("+25 coin (boost)", "success"); }
    else if (cat === "upgrade") { state.coins += 15; }
    // 'tower' kategorisi => ilgili kule tipi unlock (burada sadece bildirim;
    // gercek unlock Chain.ownsItem ile kontrol edilir)
    else if (cat === "tower") { showNotification("Yeni kule tipi açıldı (contract item #" + item.id + ")", "success"); }
  }

  function showNotification(msg, type) { GameUI.showNotification(msg, type); }

  return {
    init, start, refreshHUD, resetForNewWallet, restartGame,
    get joined() { return state.joined; },
    set joined(v) { state.joined = v; },
    get isRunning() { return state.running; },
    get entryFeeUSDC() { return state.entryFeeUSDC; },
    set entryFeeUSDC(v) { state.entryFeeUSDC = v; },
    get maxLives() { return state.maxLives; },
    set maxLives(v) { if (v) { state.maxLives = Number(v); state.lives = Number(v); } },
    get enemyMultiplier() { return state.enemyMultiplier; },
    set enemyMultiplier(v) { if (v) state.enemyMultiplier = Number(v); },
    get features() { return state.features; },
    set features(v) { state.features = v || {}; },
    get shopItems() { return state.shopItems; },
    set shopItems(v) { state.shopItems = v || []; },
    get ownedTowerItems() { return state.ownedTowerItems; },
    setOwnedTowerItems(set) { state.ownedTowerItems = set || new Set(); },
    applyItemToGameplay,
  };
})();

// DOM hazirsa baslat
(function boot() {
  function go() { GAME.init(); GameUI.onBalanceUpdated(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go);
  else go();
})();
