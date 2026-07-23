# Arc Tower Defense — Game Platform

Gelişmiş kule savunma oyunu + Arc Testnet için **üretim seviyesinde, yeniden kullanılabilir oyun platformu akıllı sözleşmesi**.

- Oyun (gameplay) tamamen **frontend**'te (canvas). Blokzincir oyun mantığı bilmez.
- Blokzincir yalnızca: **ödeme, izin, sahiplik, ekonomi yapılandırması, hazine, özellik bayrakları**.
- Sözleşme **upgradeable proxy KULLANMAZ**. Normal işletme (fiyat/mağaza/etkinlik değişimi) yeniden deploy gerektirmez — owner fonksiyonlarıyla yapılır.

## Dosya Yapısı

| Dosya | Açıklama |
|------|----------|
| `contracts/GamePlatform.sol` | Tek doğruluk kaynağı: yapılandırma registry, feature flags, generic shop, treasury, giriş sistemi, acil durum modları. |
| `abi.js` | Derlenmiş `GamePlatform` ABI'si (otomatik üretildi). |
| `config.js` | Sabit ağ/contract bilgileri + kategori/görsel tanımlar. **Fiyat yok.** |
| `wallet.js` | Cüzdan tespiti, zincir kontrolü, USDC okuma, contract çağrıları (fail-soft). |
| `chain.js` | Contract'ı tek doğruluk kaynağı yapan okuma/yazma katmanı (selector türetme + ABI decode). |
| `ui.js` | Modal'lar (Add/Upgrade), bildirimler, shop render (contract'tan), hız kontrolü. |
| `game.js` | Oyunnanış: arka plan, senaryo (gece/gündüz/yaz/kış), kule, mermi, ikinci kule, yükseltme. |
| `index.html` / `style.css` | Arayüz. |

## Arc Testnet (canlı doğrulanmış)

- chainId: `0x4cef52` (decimal 5042002) — **80749794 / 0x4D024E2 YANLIŞ**
- RPC: `https://rpc.testnet.arc.network`
- Explorer: `https://testnet.arcscan.app`
- USDC: `0x3600000000000000000000000000000000000000` (6 decimals)

## Çalıştırma (yerel)

`index.html`'i tarayıcıda aç. Cüzdan bağla (MetaMask/Rabby). Arc Testnet'te olduğundan emin ol.
Yerel `file://` testinde ağ geçişi zorlanmaz; ağı manuel Arc Testnet yap.

## Deploy (Vercel — tarayıcı)

1. GitHub'a push et (bkz. README sonundaki adımlar).
2. https://vercel.com → "Add New" → "Project" → GitHub repo'nu seç (`arc-tower-defense`).
3. Framework Preset: **Other** (statik). Build Command: **boş bırak**. Output Directory: `.` (kök).
4. Environment Variables: **GEREK YOK** — contract adresi `config.js` içinde sabit.
   (İstersen `config.js`'i değiştirmeden adresi güncellemek için Vercel'de
    `ARC_RUNTIME_CONTRACT` adında bir "Build/Project Env" tanımlayabilirsin;
    frontend bunu otomatik okur.)
5. "Deploy" → yeşil tik.

> Not: `vercel.json` sadece SPA rewrite içerir; build adımı yoktur (statik site).

## Sözleşmeyi Deploy Etme (tarayıcı — Remix)

1. https://remix.ethereum.org → `contracts/GamePlatform.sol` yapıştır.
2. Solidity Compiler → Version **0.8.24** → **Enable optimization** (runs 200) → Compile.
   (Optimizer açıkken bytecode 24576 byte altına iner; Arc Testnet zaten uygulamaz.)
3. Deploy & Run → **Injected Provider** → Arc Testnet → constructor:
   `_usdc = 0x3600000000000000000000000000000000000000`,
   `_initialOwner = <cüzdanın>`.
4. Deploy sonrası adresi kopyala → `config.js` → `gameContractAddress` alanına yapıştır.
5. İlk item'ları eklemek için Remix'te `addItem(...)` (owner çağrısı).

> Private key hiçbir zaman ajanın veya repo'nun değmez. Sadece imzalarsın.

## Güvenlik

- OpenZeppelin `Ownable2Step` + `Pausable` + `ReentrancyGuard` + `SafeERC20`.
- Custom errors, Events, Checks-Effects-Interactions, zero-address reddi.
- `no tx.origin`, `no delegatecall`, inline assembly yok.
- Tüm fiyatlar contract storage'dan; frontend fiyat belirleyemez.
- Approve → receipt bekle → purchase (race engellendi).
