// ============================================================================
// config.js  —  Tek dogruluk kaynagi: GamePlatform contract (Arc Testnet)
// ============================================================================
// Bu dosya SADECE sabit ag/contract bilgilerini ve "item kategorileri" tanimlar.
// Hicbir fiyat, bakiye, entry-fee veya oyun parametresi burada HARD-CODE
// EDILMEZ. Hepsi contract'tan okunur (GameChain + ui.js).
//
// Frontend ASLA kendi fiyatini belirleyemez. Tum fiyatlar contract storage'dan.
// ============================================================================

// Arc Testnet — canli dogrulanmis degerler (eth_chainId -> 0x4cef52)
window.ARC_CONFIG = {
  chainIdHex: "0x4cef52",          // DOGRU deger (80749794 / 0x4D024E2 YANLIS)
  chainIdDec: 5042002,
  chainName: "Arc Testnet",
  rpcUrl: "https://rpc.testnet.arc.network",
  explorer: "https://testnet.arcscan.app",
  // Sabit adres (degismez): Arc native USDC (6 decimals)
  usdcAddress: "0x3600000000000000000000000000000000000000",
  // === DEPLOY SONRASI DOLDURULACAK (Remix'ten alinan adres) ===
  // Bos birakilirsa uygulama acik bir hata gosterir ve okuma/yazma engellenir.
  gameContractAddress: "0x1f8f7cCa7799BF4B04Ec635dfCd8D1eD1B81f787",
  ownerAddress: "0xCb4D9629D3F6cc5C26dd1B6E56320602177A7a70",

  // ----------------------------------------------------------------------
  // ITEM KATEGORILERI — SADECE "category" etiketi.
  // Gercek item'lar + fiyatlar + aciklama contract'ta (owner ekler).
  // Frontend, contract'taki getAllItems()'i okuyup bu kategorilere gore
  // ikon/secim yapar. Burada sadece "hangi category ne anlama gelir" tanimi var.
  // ----------------------------------------------------------------------
  CATEGORIES: {
    TOWER:    "tower",
    ARROW:    "arrow",
    CANNON:   "cannon",
    MISSILE:  "missile",
    WEAPON:   "weapon",
    UPGRADE:  "upgrade",
    BOOST:    "boost",
    SKIN:     "skin",
  },

  // ----------------------------------------------------------------------
  // OYUN ICİ SADECE "oynanis" sabitleri (fizik/goruntu). EKONOMI DEGIL.
  // ----------------------------------------------------------------------
  GAMEPLAY: {
    canvasWidth: 960,
    canvasHeight: 540,
    pathSpeed: 60,
    towerRange: 150,
    towerBaseDamage: 18,
    spawnInterval: 1.6,
    waveEnemyCount: 12,
    startingLivesFallback: 20,
    startingCoinsFallback: 150,
  },

  // ----------------------------------------------------------------------
  // SCENARIO (gece/gunduz/yaz/kis) — tamamen frontend gorseli + oyun zorlugu.
  // "EnemyMultiplier" contract'tan gelir; bu tablo SADECE gorsel temadir.
  // ----------------------------------------------------------------------
  SCENARIOS: [
    { id: "day_spring", name: "Bahar - Gündüz", sky: ["#7ec8ff","#cdeaff"], ground: "#5b8c3a", sun: "#fff3b0", night: false, snow: false, enemyMul: 100 },
    { id: "day_summer", name: "Yaz - Gündüz",   sky: ["#4aa3ff","#bfe3ff"], ground: "#4f8a2e", sun: "#fff0a0", night: false, snow: false, enemyMul: 115 },
    { id: "night_autumn", name: "Sonbahar - Gece", sky: ["#1b2a4a","#3a2a4a"], ground: "#3e4a2a", sun: "#cdb4ff", night: true, snow: false, enemyMul: 130 },
    { id: "night_winter", name: "Kış - Gece",   sky: ["#0d1530","#26304f"], ground: "#dfe9f2", sun: "#a9c8ff", night: true, snow: true, enemyMul: 150 },
  ],

  SPEEDS: [1, 2, 3],

  // ----------------------------------------------------------------------
  // Contract feature/config ADLARI (keccak256 icin string kaynaklari).
  // Burada yazilan string'ler GamePlatform.sol'deki keccak256("...") ile
  // BIREBIR AYNI OLMALI. (Feature flag ve config anahtari eslestirmesi.)
  // ----------------------------------------------------------------------
  FEATURE_NAMES: {
    EntryFeeEnabled: "EntryFeeEnabled",
    ShopEnabled: "ShopEnabled",
    InventoryEnabled: "InventoryEnabled",
    SpecialEventsEnabled: "SpecialEventsEnabled",
    SeasonPassEnabled: "SeasonPassEnabled",
    TournamentEnabled: "TournamentEnabled",
    DailyRewardsEnabled: "DailyRewardsEnabled",
    ReferralProgramEnabled: "ReferralProgramEnabled",
    LeaderboardRewardsEnabled: "LeaderboardRewardsEnabled",
    SecondTowerEnabled: "SecondTowerEnabled",
  },
  CONFIG_NAMES: {
    EntryFee: "EntryFee",
    StartingCoins: "StartingCoins",
    MaxLives: "MaxLives",
    EnemyMultiplier: "EnemyMultiplier",
    ShopVersion: "ShopVersion",
    EconomyVersion: "EconomyVersion",
    GameVersion: "GameVersion",
    GameVersionStr: "GameVersionStr",
    Maintenance: "MaintenanceMode",
  },
};

// ----------------------------------------------------------------------
// Calisma zamanı kontrat adresi kontrolü (deploy unutulursa acik hata).
// Vercel ortaminda adresi window.ARC_RUNTIME_CONTRACT ile gecerek guncelleyebilirsin
// (config.js'i degistirmeden). Bos/gecersiz ise uygulama devre disi kalir.
// ----------------------------------------------------------------------
(function applyRuntimeContract() {
  const g = (typeof window !== "undefined") ? window : {};
  const rc = g.ARC_RUNTIME_CONTRACT;
  if (rc && typeof rc === "string" && /^0x[0-9a-fA-F]{40}$/.test(rc)) {
    window.ARC_CONFIG.gameContractAddress = rc;
  }
})();

window.GameConfigReady = (function () {
  const a = window.ARC_CONFIG.gameContractAddress || "";
  const ok = /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0+$/.test(a);
  return {
    ok,
    address: a,
    describe() {
      if (ok) return "Contract adresi: " + a;
      return "HATA: GamePlatform contract adresi tanimli degil. config.js icindeki gameContractAddress alanini Remix deploy sonrasi doldur (veya window.ARC_RUNTIME_CONTRACT ile ver).";
    },
  };
})();
