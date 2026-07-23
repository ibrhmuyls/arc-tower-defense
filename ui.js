// ============================================================================
// ui.js  —  Arayuz kontrolcu (modal'lar, bildirimler, shop, hiz, cuzdan secici)
// ============================================================================
// ONCEKI HATA: SHA-256 (crypto.subtle) ile feature hash + el yapimi ABI decode.
// YENI: tum okuma/yazma GameChain (ethers) uzerinden; decode ethers yapar.
// XSS: item metadata/html icin INNERHTML YERINE textContent/createElement.
// Onay: sinirsiz (1<<256-1) YERINE sadece gereken tutar (exact amount).
// ============================================================================

window.GameUI = (function () {
  "use strict";

  let toastTimer = null;

  function $(id) { return document.getElementById(id); }

  function showNotification(msg, type) {
    type = type || "info";
    const el = $("toast");
    if (!el) return;
    el.textContent = msg;                       // XSS-safe
    el.className = "toast toast-" + type + " show";
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = "toast"; }, 4000);
  }

  // Precompute id->name once (ethers keccak256 of the canonical string).
  let FEATURE_NAME_BY_ID = {};
  let CONFIG_NAME_BY_ID = {};
  function buildNameMaps() {
    if (typeof window.ethers === "undefined") return;
    const et = window.ethers;
    FEATURE_NAME_BY_ID = {};
    const fn = window.ARC_CONFIG.FEATURE_NAMES;
    for (const key in fn) FEATURE_NAME_BY_ID[et.keccak256(et.toUtf8Bytes(fn[key]))] = key;
    CONFIG_NAME_BY_ID = {};
    const cn = window.ARC_CONFIG.CONFIG_NAMES;
    for (const key in cn) CONFIG_NAME_BY_ID[et.keccak256(et.toUtf8Bytes(cn[key]))] = key;
  }
  function featureNameFromId(idHex) { return FEATURE_NAME_BY_ID[idHex] || idHex; }

  // ---------------- Cuzdan secici ----------------
  function showWalletPicker() {
    const list = window.Wallet.detectProviders();
    const wrap = $("wallet-list");
    if (wrap) wrap.replaceChildren();          // XSS-safe clear
    if (!list.length) {
      showNotification("Cüzdan bulunamadı. Tarayıcıya MetaMask/Rabby kurulu olmalı.", "error");
      return;
    }
    list.forEach((w) => {
      const card = document.createElement("button");
      card.className = "wallet-option";
      card.textContent = w.name;               // XSS-safe
      card.onclick = () => { closeModal("wallet-modal"); window.Wallet.connect(w.provider); };
      wrap.appendChild(card);
    });
    openModal("wallet-modal");
  }

  function openModal(id) { const m = $(id); if (m) m.classList.add("open"); }
  function closeModal(id) { const m = $(id); if (m) m.classList.remove("open"); }

  function setButtonsDisabled(disabled) {
    document.querySelectorAll("[data-buy]").forEach((b) => { b.disabled = disabled; });
    const joinBtn = $("join-btn"); if (joinBtn) joinBtn.disabled = disabled;
    const addBtn = $("add-tower-btn"); if (addBtn) addBtn.disabled = disabled;
  }

  // ---------------- Wallet hook'lari ----------------
  function onWalletConnected() {
    const btn = $("connect-btn");
    if (btn) { btn.textContent = shortAddr(WALLET_STATE.address); btn.classList.add("connected"); }
    refreshWalletUI();
    syncFromContract();
  }
  function onWalletDisconnected() {
    const btn = $("connect-btn");
    if (btn) { btn.textContent = "Cüzdan Bağla"; btn.classList.remove("connected"); }
    $("wallet-addr").textContent = "—";
    $("usdc-bal").textContent = "0.00";
  }
  function onBalanceUpdated() {
    $("usdc-bal").textContent = (WALLET_STATE.usdcBalance || 0).toFixed(2);
  }
  function shortAddr(a) { return a ? a.slice(0, 6) + "…" + a.slice(-4) : "—"; }

  async function refreshWalletUI() {
    if (!WALLET_STATE.connected) return;
    $("wallet-addr").textContent = shortAddr(WALLET_STATE.address);
    await window.Wallet.refreshBalance();
  }

  // ---------------- Contract'tan okuma: config + features + shop ----------------
  // Tum cagrilar GameChain.read(...) uzerinden -> ethers Contract -> gercek ABI decode.
  async function syncFromContract() {
    if (!WALLET_STATE.connected) return;
    if (!window.GameChain.isReady()) { showNotification(window.GameConfigReady.describe(), "warn"); return; }
    buildNameMaps();
    try {
      // Entry fee + ucretsiz mi?
      const [fee, free] = await Promise.all([
        window.GameChain.read("entryFee"),
        window.GameChain.read("isGameFree"),
      ]);
      const feeNum = Number(fee) / 1e6;
      window.GAME.entryFeeUSDC = feeNum;
      const feeLabel = free ? "Ücretsiz giriş" : ("Giriş: " + feeNum.toFixed(2) + " USDC");
      const fb = $("entry-fee-label"); if (fb) fb.textContent = feeLabel;
      const joinBtn = $("join-btn");
      if (joinBtn) joinBtn.textContent = free ? "Oyuna Katıl (Ücretsiz)" : ("Oyuna Katıl (" + feeNum.toFixed(2) + " USDC)");

      // Features (bytes32[] ids, bool[] states) — ethers decode eder
      const feats = await readFeatures();
      window.GAME.features = feats;
      const secondTower = !!feats["SecondTowerEnabled"];
      const addBtn = $("add-tower-btn");
      if (addBtn) addBtn.style.display = secondTower ? "" : "none";

      // Config: MaxLives, StartingCoins, EnemyMultiplier
      const [maxLives, startCoins, enemyMul, maintenance] = await Promise.all([
        getConfigUint("MaxLives"),
        getConfigUint("StartingCoins"),
        getConfigUint("EnemyMultiplier"),
        window.GameChain.read("getBoolConfig", window.GameChain.idHash(window.ARC_CONFIG.CONFIG_NAMES.Maintenance)),
      ]);
      if (maxLives) window.GAME.maxLives = Number(maxLives);
      if (startCoins) { window.GAME.startingCoins = Number(startCoins); window.GAME.coins = Number(startCoins); }
      if (enemyMul) window.GAME.enemyMultiplier = Number(enemyMul) / 100;

      // Bakim modu (contract onlyUsable): okuma calisir, yazma engellenir.
      // Frontend kullaniciya bunu acikca gosterir (contract zaten reddeder).
      const maint = !!maintenance;
      const joinBtn2 = $("join-btn");
      if (joinBtn2) { joinBtn2.disabled = maint; joinBtn2.title = maint ? "Bakım modu — geçici olarak kapalı" : ""; }
      if (maint) showNotification("Sistem bakım modunda — alım/katılım geçici kapalı", "warn");

      // Shop + inventory (kule unlock icin ownsItem)
      await renderShop();
      updateHUD();
    } catch (e) {
      showNotification("Contract senkron hatası: " + Wallet.shortErr(e), "error");
    }
  }

  async function getConfigUint(name) {
    const id = window.GameChain.idHash(window.ARC_CONFIG.CONFIG_NAMES[name]);
    return window.GameChain.read("getUintConfig", id);
  }

  async function readFeatures() {
    const res = await window.GameChain.read("getAllFeatures");
    // res = [ ids: bytes32[], states: bool[] ]  (ethers decode)
    const ids = res[0], states = res[1];
    const out = {};
    for (let i = 0; i < ids.length; i++) out[featureNameFromId(ids[i])] = !!states[i];
    return out;
  }

  // ---------------- Shop render (contract'tan, gercek decode) ----------------
  async function renderShop() {
    const grid = $("shop-grid");
    if (grid) grid.replaceChildren();          // XSS-safe clear
    let items = [];
    try {
      items = await readAllItems();            // ethers decode -> Item[]
    } catch (e) {
      showNotification("Mağaza okunamadı: " + Wallet.shortErr(e), "error");
      return;
    }
    window.GAME.shopItems = items;
    const owner = WALLET_STATE.connected ? WALLET_STATE.address : null;
    const ownedSet = new Set();
    if (owner) {
      const owns = await readInventory(owner, items.map((i) => i.id));
      owns.forEach((o, idx) => { if (o) { ownedSet.add(items[idx].id); } });
      // Kule unlock icin: tower kategorili item id'lerini game state'e aktar
      const towerItemIds = new Set(items.filter((i) => i.category === "tower").map((i) => i.id));
      const ownedTower = new Set([...ownedSet].filter((id) => towerItemIds.has(id)));
      if (window.GAME && window.GAME.setOwnedTowerItems) window.GAME.setOwnedTowerItems(ownedTower);
    }

    items.forEach((it) => {
      if (!it.enabled) return;
      const card = document.createElement("div");
      card.className = "shop-card cat-" + (it.category || "misc");

      const icon = document.createElement("div");
      icon.className = "shop-icon";
      icon.textContent = categoryIcon(it.category);

      const title = document.createElement("div");
      title.className = "shop-title";
      title.textContent = itemTitle(it);       // metadata JSON -> textContent (XSS-safe)

      const cat = document.createElement("div");
      cat.className = "shop-cat";
      cat.textContent = it.category || "misc";

      const price = document.createElement("div");
      price.className = "shop-price";
      price.textContent = it.paymentRequired ? (Number(BigInt(it.price)) / 1e6).toFixed(2) + " USDC" : "Ücretsiz";

      const own = document.createElement("div");
      own.className = "shop-owned";
      own.textContent = ownedSet.has(it.id) ? "✓ Sahip" : "";

      const btn = document.createElement("button");
      btn.className = "buy-btn";
      btn.setAttribute("data-buy", "1");
      btn.textContent = "Al";
      btn.onclick = () => buyItem(it);

      card.append(icon, title, cat, price, own, btn);
      grid.appendChild(card);
    });
  }

  // ethers'dan gelen Item struct -> { id, price, enabled, paymentRequired, maxPurchasesPerPlayer, metadataURI, category }
  async function readAllItems() {
    const arr = await window.GameChain.read("getAllItems");
    // arr: Item[] (ethers decode). metadataURI string, category string.
    return (arr || []).map((it) => ({
      id: Number(it.id),
      price: (it.price || 0n).toString(),
      enabled: !!it.enabled,
      paymentRequired: !!it.paymentRequired,
      maxPurchasesPerPlayer: Number(it.maxPurchasesPerPlayer || 0),
      metadataURI: it.metadataURI || "",
      category: it.category || "misc",
    }));
  }

  async function readInventory(owner, ids) {
    // ownsItem(address,uint256) -> bool[] (paralel)
    return Promise.all(ids.map((id) => window.GameChain.read("ownsItem", owner, id).catch(() => false)));
  }

  function itemTitle(it) {
    const m = it.metadataURI;
    if (m && m.length > 2) {
      try { const j = JSON.parse(m); if (j && j.name) return j.name; } catch {}
    }
    return "Item #" + it.id;
  }
  function categoryIcon(cat) {
    const m = { tower: "🏰", arrow: "🏹", cannon: "💣", missile: "🚀", weapon: "⚔️", upgrade: "⬆️", boost: "⚡", skin: "🎨" };
    return m[cat] || "📦";
  }

  // ---------------- Satin alma (contract -> tek dogruluk) ----------------
  async function buyItem(item) {
    if (!WALLET_STATE.connected) { showNotification("Önce cüzdan bağla", "warn"); return; }
    if (!window.GameChain.isReady()) { showNotification(window.GameConfigReady.describe(), "warn"); return; }
    if (!(await window.Wallet.ensureChain())) return;

    // FRONTEND FIYAT BELIRLEMEZ. Contract'tan taze item oku (guven siniri).
    let fresh;
    try { fresh = (await readAllItems()).find((i) => i.id === item.id); }
    catch (e) { showNotification("Item okunamadı: " + Wallet.shortErr(e), "error"); return; }
    if (!fresh || !fresh.enabled) { showNotification("Item pasif", "error"); return; }

    const costRaw = BigInt(fresh.price || "0");
    if (fresh.paymentRequired && costRaw > 0n) {
      const ok = await window.GameChain.ensureApproval(costRaw, (m) => showNotification(m, "info"));
      if (!ok) { showNotification("USDC onayı başarısız", "error"); return; }
    }

    setButtonsDisabled(true);
    const res = await window.GameChain.write("buyItem", [BigInt(item.id)]);
    setButtonsDisabled(false);
    if (res.ok) {
      onItemBought(item);
      window.Wallet.refreshBalance();
    } else {
      showNotification("Alım başarısız: " + Wallet.shortErr(res.error), "error");
    }
  }

  function onItemBought(item) {
    showNotification("Satın alındı: " + categoryIcon(item.category) + " #" + item.id, "success");
    window.GAME.applyItemToGameplay(item);
    syncFromContract();
  }

  // ---------------- Join ----------------
  async function joinGame() {
    if (!WALLET_STATE.connected) { showNotification("Önce cüzdan bağla", "warn"); return; }
    if (!window.GameChain.isReady()) { showNotification(window.GameConfigReady.describe(), "warn"); return; }
    if (!(await window.Wallet.ensureChain())) return;

    // Entry fee gerekiyorsa exact-amount onay
    let fee = 0n;
    try {
      const [f, free] = await Promise.all([window.GameChain.read("entryFee"), window.GameChain.read("isGameFree")]);
      if (!free && BigInt(f) > 0n) {
        fee = BigInt(f);
        const ok = await window.GameChain.ensureApproval(fee, (m) => showNotification(m, "info"));
        if (!ok) { showNotification("Giriş ücreti onayı başarısız", "error"); return; }
      }
    } catch (e) { showNotification("Giriş kontrolü hatası: " + Wallet.shortErr(e), "error"); return; }

    const res = await window.GameChain.write("joinGame", []);
    if (res.ok) {
      window.GAME.joined = true;
      showNotification("Oyuna katıldın!", "success");
      window.GAME.start();
    } else {
      showNotification("Katılım başarısız: " + Wallet.shortErr(res.error), "error");
    }
  }

  function updateHUD() { if (window.GAME && window.GAME.refreshHUD) window.GAME.refreshHUD(); }

  return {
    showNotification, openModal, closeModal, setButtonsDisabled,
    onWalletConnected, onWalletDisconnected, onBalanceUpdated, refreshWalletUI,
    showWalletPicker, syncFromContract, renderShop, buyItem, joinGame, updateHUD,
    featureNameFromId,
  };
})();
