# GamePlatform — Mimari, Depolama, Güvenlik ve Genişleme Stratejisi

Bu belge, `contracts/GamePlatform.sol` sözleşmesinin tasarımını profesyonel bir
Web3 oyun platformu olarak belgeler. Amaç: normal işletme (ekonomi ayarı, mağaza
güncelleme, etkinlik, fiyat, oyun modu değişimi) **asla yeni contract deploy
etmeyi gerektirmesin**.

---

## 1. Mimari (Architecture)

### Prensip: Blokzincir oyun oynamaz

```
┌─────────────────────────┐         eth_call / eth_sendTx        ┌──────────────────────────┐
│  FRONTEND (tarayıcı)    │  ───────────────────────────────▶   │  GamePlatform (Arc Testnet)
│  - Canvas oyunnanış     │  ◀───────────────────────────────   │  - payments (USDC)       │
│  - Dalga/düşman/skor    │     events + state read             │  - permissions (owner)   │
│  - Senaryo (gece/kış)   │                                      │  - ownership (inventory)│
│  - Kule/mermi fizik     │                                      │  - config registry       │
│  - UI / modal'lar       │                                      │  - feature flags         │
└─────────────────────────┘                                      │  - treasury (USDC)       │
                                              SafeERC20 ───────▶ │                          │
                                              balances           │  (Oyun mantığı YOK)      │
                                                                └──────────────────────────┘
```

- **Frontend**: tüm gameplay (hasar, dalga, render, senaryo, hızlandırma, ikinci
  kule fizik). Contract'tan SADECE izin/economy/ownership/fiyat okur.
- **Contract**: generic, gameplay-bağımsız primitive'ler. Hiçbir oyun değişkeni
  (hasar, menzil, dalga sayısı) tutmaz.

### Neden upgradeable proxy YOK?

Proxy'ler:
- Karmaşık (UUPS/transparent), saldırı yüzeyi büyür (delegatecall, storage
  collision, initialization exploit).
- "Owner istediği anda logic'i değiştirebilir" = oyuncular için güvensiz izlenim.

Bizim yaklaşımımız: **generic configurable primitives**. Owner; config, feature,
item'ları çağrılarla değiştirir. Yeni bir "oyun modu" eklemek = yeni bir config
anahtarı + frontend'in onu okuması. Yeni bir item = `addItem`. Yeniden deploy
gerekmez. Sadelik ve güvenlik öne çıkar.

### Generic primer yapısı

| Modül | Şekil | Örnek |
|------|-------|-------|
| Config Registry | `mapping(bytes32 => ConfigValue)` | `EntryFee`, `MaxLives`, `EnemyMultiplier` |
| Feature Flags | `mapping(bytes32 => bool)` | `ShopEnabled`, `SecondTowerEnabled` |
| Shop | `buyItem(itemId)` + generic `Item` | ok, top, füze, silah, boost |
| Treasury | USDC custogy + `withdrawTreasury` | — |

---

## 2. Depolama Yerleşimi (Storage Layout)

### Sabitler (immutable)
- `IERC20 public immutable usdc;` — tek kabul edilen ödeme token'ı. Deploy
  anında mühürlenir; değiştirilemez.

### Generic Configuration Registry
```
mapping(bytes32 => ConfigValue) private _config;   // id keccak256("EntryFee") -> değer
bytes32[] private _configKeys;                     // keşfedilebilir liste
mapping(bytes32 => bool) private _configExists;    // yinelenen key engeli
```
`ConfigValue { uint8 kind; uint256 asUint; address asAddress; bool asBool; string asString; }`
— tek struct, 4 tipi (uint/address/bool/string) kapsar. Yeni tip = yeni `kind`
sabitı, mevcut mantık bozulmaz.

### Feature Flags
```
mapping(bytes32 => bool) private _features;   // keccak256("ShopEnabled") -> bool
bytes32[] private _featureKeys;
```

### Shop Items
```
mapping(uint256 => Item) private _items;      // id -> generic item
uint256[] private _itemIds;
mapping(uint256 => bool) private _itemExists; // yinelenen id engeli
```
`Item { id; price; enabled; paymentRequired; maxPurchasesPerPlayer; metadataURI; category; }`
— **hiçbir gameplay alanı yok**. Sadece ekonomik + sahiplik verisi.

### Player Storage
```
mapping(address => bool) public joinedPlayers;
mapping(address => mapping(uint256 => bool)) public ownedItems;
mapping(address => mapping(uint256 => uint256)) public purchaseCount;
mapping(address => uint256[]) private _inventory;
address[] private _players;                    // owner reset için
```

### Storage slot optimizasyonu
- Tüm `mapping` + `bytes32[]` + `address[]` referans türleri; calldata yerine
  `memory`/`private` helper ile gaz optimize.
- `immutable usdc` → okuma cheap (3 gas slot yerine kodda sabit).

---

## 3. Güvenlik Modeli

### Zorunlu bileşenler (OZ v5)
- **Ownable2Step**: iki adımlı devir (owner变更de rug riskini azaltır).
- **Pausable**: `pause()`/`unpause()` — acil durumda TÜM state-changing işlemleri
  kilitler. Okuma devam eder.
- **ReentrancyGuard**: `nonReentrant` — treasury ve satın alma.
- **SafeERC20**: USDC transferleri için (eksik dönüş/return false güvenli).

### Kontrol desenleri
- **Checks-Effects-Interactions**: `buyItem`'da USDC transferi EN SON (effect'ler
  uygulandıktan sonra). Reentrancy + tutarsızlık engellenir.
- **Custom Errors**: gaz dostu, net revert mesajı.
- **Events**: her önemli değişim (`ItemPurchased`, `ConfigUpdated`, …).
- **Zero-address reddi**: constructor, `setTreasuryAddress`, `resetPlayerAccess`.
- **Duplicate/invalid item reddi**: `addItem` `_itemExists` kontrolü.
- **Disabled item reddi**: `buyItem` `ItemDisabled`.
- **Invalid payment reddi**: `paymentRequired && price==0` → revert.
- **Yanlış USDC reddi**: `rescueToken`'da USDC'yi engelle (hazine yanlış yere gitmez).

### YASAKLANMIŞ
- `tx.origin` → yok (sadece `msg.sender`).
- `delegatecall` → yok (proxy yok).
- inline assembly → yok (gereksiz).
- Frontend fiyatına güven → yok (her satın alma contract'tan tekrar okur).

### Acil Modlar
| Mod | Davranış |
|-----|----------|
| Normal | her şey serbest |
| Maintenance (`MaintenanceMode` config) | join + buy kapalı, okuma açık |
| Emergency (`pause()`) | tüm state-changing kilitli |

### Onay/Yatırım race (öğrenilmiş ders)
`buyItem` öncesi `approve` gönderilir; **approve receipt beklenmeden** `buyItem`
yollanmaz. Aksi halde allowance=0 → `safeTransferFrom` fail. Akış:
`approve(max) → waitReceipt → buyItem → waitReceipt → UI güncelle`.

---

## 4. Her Modül Neden Var?

| Modül | Neden |
|------|-------|
| Config Registry | Ekonomi (başlangıç coin, can, düşman çarpanı, sezon) tek yerden, redeploy'suz değişir. |
| Feature Flags | Yeni özellik (turnuva, sezon bileti, referans) kod değişmeden aç/kapa. Frontend flag'ı sorgular. |
| Generic Shop (`buyItem`) | `buySword/buyBow/...` yerine tek fonksiyon. Yeni ürün = yeni `Item` satırı. |
| Item (generic) | Gameplay'e bağlı alan yok → sözleşme oyun-bağımsız kalır, yeniden kullanılabilir. |
| Owner fonksiyonları (batch) | Gaz + işlem sayısı azaltır; mağazayı toplu güncelle. |
| Player Storage | `joinedPlayers`, `ownedItems`, `purchaseCount` → izin + sahiplik + envanter sorgusu. |
| Treasury | USDC contract'ta; owner `withdrawTreasury` ile çeker. SafeERC20 zorunlu. |
| Emergency/Maintenance | Planlı bakım ve acil kilit — oyuncu fonu korunur, okuma sürer. |
| Entry System | Ücretsiz (Mode 1) veya ücretli (Mode 2, config'e bağlı). Tekrar ödeme yok (reset hariç). |
| Frontend API | `isGameFree`, `entryFee`, `getItem`, `getAllItems`, `ownsItem`, `getInventory` — temiz read. |

---

## 5. Gelecek Genişleme Stratejisi

1. **Yeni config değeri**: `setUintConfig(keccak256("NewThing"), v)`. Frontend
   `getUintConfig` ile okur. Sözleşme değişmez.
2. **Yeni özellik**: `setFeature(keccak256("NewFeature"), true)`. Frontend
   `isFeatureEnabled` ile davranışı değiştirir.
3. **Yeni ürün**: `addItem(ItemInput{...})`. UI `category` ile ikon seçer.
4. **Yeni oyun modu**: `setStringConfig(keccak256("GameMode"), "bossRush")`.
   Frontend moda göre gameplay dallandırır.
5. **Yeni token desteği**: şu an `immutable usdc`. Gerekirse `mapping(token=>bool)
   acceptedTokens` eklenebilir (ama mevcut tasarım tek-token sadeliğini korur).
6. **Off-chain metadata**: `metadataURI` (ipfs://…) ile item görseli/açıklaması.
   Sözleşme sadece URI tutar; içerik IPFS'te.
7. **Season/leaderboard**: `SeasonNumber` config + `LeaderboardRewardsEnabled`
   flag ile ödül dağıtımı frontend/oracle'a bırakılır; sözleşme sadece
   yetki/ödeme kapısıdır.

**Genişleme kuralı**: "özel fonksiyon" EKLEME; "generic primitive" ile ifade ET.

---

## 6. Sözleşme Özeti (Implementasyon)

Tam kaynak: `contracts/GamePlatform.sol`. Derleme: `solc 0.8.24` + OZ `5.0.2`.
ABI: `abi.js`.

Ana fonksiyonlar:
- `joinGame()`, `resetPlayerAccess()`, `resetAllAccess()`
- `setUintConfig/setAddressConfig/setBoolConfig/setStringConfig`, `updateEntryFee()`
- `setFeature()`, `isFeatureEnabled()`
- `addItem()`, `addItems()`, `removeItem()`, `enableItem()`, `disableItem()`,
  `batchEnableItems()`, `batchDisableItems()`, `updateItemPrice(s)`,
  `updateItemMetadata()`, `makeItemFree()`, `requireItemPayment()`
- `buyItem(itemId)` — generic, CEI, reentrancy guard
- `getItem()`, `getAllItems()`, `ownsItem()`, `getInventory()`, `getPurchaseCount()`
- `withdrawTreasury()`, `treasuryBalance()`, `rescueToken()`
- `pause()`, `unpause()`, `enableMaintenance()`, `disableMaintenance()`

---

## 9. Arc Testnet Deployment Checklist

### Öncesi (doğrula)
- [ ] `eth_chainId` → `0x4cef52` (canlı RPC). Yanlış: `0x4D024E2`/80749794.
- [ ] USDC adresi: `0x3600000000000000000000000000000000000000` (kodda var).
- [ ] `solc 0.8.24` + OZ `5.0.2` ile derleme hatasız (yapıldı).

### Deploy (Remix, tarayıcı)
- [ ] `contracts/GamePlatform.sol` Remix'e yapıştır; OZ import'ları çöz.
- [ ] Compiler 0.8.24, optimization on (200 runs).
- [ ] Deploy → Injected Provider → Arc Testnet.
- [ ] Constructor args: `_usdc = 0x3600…0000`, `_initialOwner = <senin cüzdanın>`.
- [ ] İmzala. Adresi kopyala.

### Sonrası
- [ ] Explorer'da adresi yapıştır; `Contract` sekmesinde doğrula (source + ABI).
- [ ] `config.js` → `gameContractAddress` ve `ownerAddress` doldur.
- [ ] Vercel env: `VITE_GAME_CONTRACT_ADDRESS`, `VITE_OWNER_ADDRESS`.
- [ ] (Owner) Başlangıç item'larını ekle: `addItems([...])` (ok/top/füze/silah/boost).
- [ ] `setFeature(keccak256("ShopEnabled"), true)` vb. ayarla.
- [ ] `entryFee()` default 0 (ücretsiz). İstersen `updateEntryFee(usdcAmount)`.

### Doğrulama (test)
- [ ] `isGameFree()` → true (fee=0 iken).
- [ ] `joinGame()` → `PlayerJoined` event.
- [ ] `buyItem(id)` (ücretli) → önce `approve`, sonra `ItemPurchased`.
- [ ] `ownsItem(addr,id)` → true.
- [ ] `treasuryBalance()` > 0 → `withdrawTreasury(amount)` → USDC owner'a.

### Güvenlik son kontrol
- [ ] Private key hiçbir yere yazılmadı.
- [ ] `0x4D024E2` / `80749794` repo'da YOK (sadece `0x4cef52`/`5042002`).
- [ ] Proxy/class delegatecall YOK.
- [ ] Frontend fiyat hardcoded DEĞİL (hepsi contract'tan).
