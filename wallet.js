// ============================================================================
// wallet.js  —  Cuzdan tespiti, zincir kontrolu, ethers Provider/Signer
// ============================================================================
// Tum ag cagrilari ethers.BrowserProvider uzerinden yapilir. Eski el yapimi
// eth_call/eth_sendTransaction kodu kaldirildi. Fail-soft: hatalar UI'da gosterilir.

window.WALLET_STATE = {
  provider: null,      // ethers.BrowserProvider
  signer: null,
  address: null,
  connected: false,
  usdcBalance: 0,      // sadece zincirden okunur (balanceOf), asla simule edilmez
  chainOk: false,
  pending: false,
};

(function () {
  "use strict";

  function ethersLib() {
    if (typeof window.ethers === "undefined") throw new Error("ethers yuklu degil");
    return window.ethers;
  }

  function detectProviders() {
    const w = window;
    const found = [];
    const push = (name, p) => { if (p && p.request) found.push({ name, provider: p }); };
    if (w.ethereum) {
      if (Array.isArray(w.ethereum.providers)) {
        w.ethereum.providers.forEach((p, i) => push("Cuzdan " + (i + 1), p));
      } else {
        push("Injected", w.ethereum);
      }
    }
    push("Rabby", w.rabby);
    push("Trust", w.trustwallet);
    push("Coinbase", w.coinbaseWalletExtension);
    const seen = new Set();
    return found.filter((f) => {
      if (seen.has(f.provider)) return false;
      seen.add(f.provider);
      return true;
    });
  }

  async function connect(providerObj) {
    try {
      const et = ethersLib();
      const ethProvider = new et.BrowserProvider(providerObj);
      const accounts = await ethProvider.send("eth_requestAccounts", []);
      if (!accounts || !accounts.length) throw new Error("Hesap donmedi");
      const signer = await ethProvider.getSigner();

      WALLET_STATE.provider = ethProvider;
      WALLET_STATE.signer = signer;
      WALLET_STATE.address = accounts[0];
      WALLET_STATE.connected = true;

      // Contract orneklerini kur (adres yoksa anlamli hata verir)
      try {
        window.GameChain.init(ethProvider, signer);
      } catch (e) {
        GameUI.showNotification(e.message, "warn");
      }

      await checkChain();
      await refreshBalance();
      wireAccountEvents(providerObj);
      GameUI.onWalletConnected();
    } catch (e) {
      GameUI.showNotification("Cuzdan baglanamadi: " + shortErr(e), "error");
    }
  }

  async function checkChain() {
    if (!WALLET_STATE.provider) return false;
    try {
      const net = await WALLET_STATE.provider.getNetwork();
      WALLET_STATE.chainOk = (String(net.chainId) === String(window.ARC_CONFIG.chainIdDec));
      if (!WALLET_STATE.chainOk) {
        GameUI.showNotification("Arc Testnet'e gecis gerekli (yanlis ag)", "warn");
      }
      return WALLET_STATE.chainOk;
    } catch {
      WALLET_STATE.chainOk = false;
      return false;
    }
  }

  async function ensureChain() {
    if (WALLET_STATE.chainOk) return true;
    const isLocal = location.protocol === "file:";
    if (isLocal) {
      GameUI.showNotification("Yerel test: agi Arc Testnet olarak manuel ayarla", "warn");
      return WALLET_STATE.chainOk;
    }
    try {
      await WALLET_STATE.provider.send("wallet_switchEthereumChain", [{ chainId: window.ARC_CONFIG.chainIdHex }]);
      WALLET_STATE.chainOk = true;
      return true;
    } catch (e) {
      if (e && e.code === 4902) {
        try {
          await WALLET_STATE.provider.send("wallet_addEthereumChain", [{
            chainId: window.ARC_CONFIG.chainIdHex,
            chainName: window.ARC_CONFIG.chainName,
            nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
            rpcUrls: [window.ARC_CONFIG.rpcUrl],
            blockExplorerUrls: [window.ARC_CONFIG.explorer],
          }]);
          WALLET_STATE.chainOk = true;
          return true;
        } catch (e2) {
          GameUI.showNotification("Arc Testnet eklenemedi: " + shortErr(e2), "error");
          return false;
        }
      }
      GameUI.showNotification("Ag degistirilemedi: " + shortErr(e), "error");
      return false;
    }
  }

  async function refreshBalance() {
    if (!WALLET_STATE.connected || !window.GameChain.isReady()) return;
    try {
      const bal = await window.GameChain.usdcBalance();
      WALLET_STATE.usdcBalance = Number(bal) / 1e6;
      GameUI.onBalanceUpdated();
    } catch {
      WALLET_STATE.usdcBalance = 0;
    }
  }

  function disconnect() {
    WALLET_STATE.provider = null;
    WALLET_STATE.signer = null;
    WALLET_STATE.address = null;
    WALLET_STATE.connected = false;
    WALLET_STATE.usdcBalance = 0;
    WALLET_STATE.chainOk = false;
    if (window.GAME && window.GAME.resetForNewWallet) window.GAME.resetForNewWallet();
    GameUI.onWalletDisconnected();
  }

  function wireAccountEvents(providerObj) {
    if (!providerObj || !providerObj.on) return;
    providerObj.on("accountsChanged", (accs) => {
      if (!accs || !accs.length) { disconnect(); }
      else { WALLET_STATE.address = accs[0]; refreshBalance(); GameUI.onWalletConnected(); }
    });
    providerObj.on("chainChanged", () => { checkChain(); });
  }

  function shortErr(e) {
    const m = (e && e.message) ? e.message : String(e);
    return m.length > 90 ? m.slice(0, 90) + "…" : m;
  }

  window.Wallet = {
    detectProviders, connect, disconnect, ensureChain, checkChain, refreshBalance, shortErr,
    get address() { return WALLET_STATE.address; },
  };
})();
