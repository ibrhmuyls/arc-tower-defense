// ============================================================================
// chain.js  —  Contract'i "tek dogruluk kaynagi" yapan okuma/yazma katmani
// ============================================================================
// ONCEKI HATA: SHA-256 (crypto.subtle) ile selector/config/feature hash uretiyorduk.
// Ethereum KECCAK-256 kullanir; SHA-256 GECMEZ. Bu surum ethers v6
// (BrowserProvider + Contract + Interface) uzerinden gercek Keccak selector'lari
// ve gercek ABI decode kullanir. El yapimi encode/decode TAMAMEN kaldirilmistir.
//
// Okuma fonksiyonlari (isGameFree, entryFee, getConfig, isFeatureEnabled,
// getItem, getAllItems, ownsItem, getInventory...) buradan gecer.
// Fiyatlar/entry-fee/feature-flag'ler frontend'te HARD-CODE EDILMEZ.
// ============================================================================

window.GameChain = (function () {
  "use strict";

  let provider = null;   // ethers.BrowserProvider (okuma + yazma icin)
  let signer = null;     // ethers.Signer (yazma icin)
  let readContract = null;
  let writeContract = null;
  let usdcRead = null;
  let usdcWrite = null;
  let iface = null;

  function eth() {
    if (typeof window.ethers === "undefined") {
      throw new Error("ethers kutuphanesi yuklenemedi (vendor/ethers.umd.min.js)");
    }
    return window.ethers;
  }

  function contractAddress() {
    const a = (window.ARC_CONFIG && window.ARC_CONFIG.gameContractAddress) || "";
    if (!a || a.length !== 42 || !a.startsWith("0x") || /^0x0+$/.test(a)) {
      return null; // deploy edilmemis
    }
    return a;
  }

  // Baglaninca cagrilir: provider + signer + contract ornekleri kurulur.
  function init(browserProvider, signerInstance) {
    const et = eth();
    provider = browserProvider;
    signer = signerInstance;
    const addr = contractAddress();
    if (!addr) throw new Error("Contract adresi tanimli degil. config.js icindeki gameContractAddress'i Remix deploy sonrasi doldur.");

    iface = new et.Interface(window.GAME_PLATFORM_ABI);
    readContract = new et.Contract(addr, window.GAME_PLATFORM_ABI, provider);
    writeContract = new et.Contract(addr, window.GAME_PLATFORM_ABI, signer);
    const usdc = window.ARC_CONFIG.usdcAddress;
    usdcRead = new et.Contract(usdc, ERC20_ABI, provider);
    usdcWrite = new et.Contract(usdc, ERC20_ABI, signer);
    return { addr, iface };
  }

  function isReady() { return !!readContract; }

  // ---- Gercek Keccak selector (ethers uzerinden, dogrulanabilir) ----
  function selector(fnSig) {
    if (!iface) iface = eth().Interface.from(window.GAME_PLATFORM_ABI);
    return iface.getFunction(fnSig).selector;
  }

  // bytes32 config/feature id = keccak256(name) (gercek Ethereum hash)
  function idHash(name) { return eth().keccak256(eth().toUtf8Bytes(name)); }

  // ---- Generic READ (ethers Contract ile, gercek ABI decode) ----
  // Ornek: await Chain.read("entryFee") -> bigint
  //        await Chain.read("getUintConfig", idHash("MaxLives")) -> bigint
  async function read(name, ...args) {
    if (!readContract) throw new Error("Chain okuma modu hazir degil (once cuzdan bagla).");
    return readContract[name](...args);
  }

  // ---- Generic WRITE (ethers Contract, cuzdan onayi + receipt bekler) ----
  // doner: { ok:true, hash, receipt } veya { ok:false, error }
  async function write(name, args, opts) {
    if (!writeContract) throw new Error("Chain yazma modu hazir degil (once cuzdan bagla).");
    opts = opts || {};
    try {
      const tx = await writeContract[name](...(args || []), opts.overrides || {});
      const receipt = await tx.wait();
      return { ok: true, hash: tx.hash, receipt };
    } catch (e) {
      return { ok: false, error: e };
    }
  }

  // ---- USDC exact-amount approval (sinirsiz onay YOK) ----
  // Sadece gereken tutar kadar onay verir. Bazi token'lar non-zero'dan artirmayi
  // sevmedigi icin: once 0'a cek, receipt bekle, sonra tutari ayarla.
  async function ensureApproval(amount, onStatus) {
    if (!usdcWrite) throw new Error("USDC yazma modu hazir degil.");
    const spender = contractAddress();
    const owner = await signer.getAddress();
    const current = await usdcRead.allowance(owner, spender);
    if (current >= amount) return true;
    const status = (m) => { if (onStatus) onStatus(m); };
    try {
      if (current > 0n) {
        status("Mevcut onay sifirlaniyor...");
        const t1 = await usdcWrite.approve(spender, 0n);
        await t1.wait();
      }
      status("USDC onayi gonderiliyor (sadece bu tutar)...");
      const t2 = await usdcWrite.approve(spender, amount);
      const r = await t2.wait();
      return !!r && r.status === "0x1";
    } catch (e) {
      return false;
    }
  }

  // ---- USDC bakiye (gercek balanceOf) ----
  async function usdcBalance() {
    if (!usdcRead) throw new Error("USDC okuma modu hazir degil.");
    return usdcRead.balanceOf(await signer.getAddress());
  }

  return {
    init, isReady, selector, idHash, contractAddress,
    read, write, ensureApproval, usdcBalance,
    get iface() { return iface; },
  };
})();

// Standart ERC20 ABI (sadece ihtiyacimiz olanlar) — ethers ile gercek decode.
window.ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
];
