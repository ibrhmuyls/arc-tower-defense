// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title GamePlatform
/// @notice Reusable, production-grade, configurable game-platform contract for Arc Testnet.
/// @dev The blockchain implements NO gameplay. It is responsible ONLY for:
///      - payments (USDC entry fees & shop purchases)
///      - permissions (owner, players, access resets)
///      - ownership (item ownership / inventory)
///      - economy & feature configuration (generic registries)
///      - treasury (USDC custody + owner withdrawal)
///      - feature flags (toggle behavior without redeployment)
///
///      All game logic (damage, waves, scoring, rendering) lives in the frontend.
///      This contract stores generic, gameplay-agnostic data only.
///
///      Upgradeable proxy patterns are deliberately NOT used. Normal operation
///      (tuning economy, updating the shop, enabling events, changing prices or
///      game modes) is performed through owner configuration functions — never
///      through redeployment.
contract GamePlatform is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Custom errors (save gas, give precise revert reasons)
    // ---------------------------------------------------------------------
    error ZeroAddress();
    error InvalidUSDC();
    error ZeroAmount();
    error InvalidItemId();
    error DuplicateItem(uint256 id);
    error ItemNotFound(uint256 id);
    error ItemDisabled(uint256 id);
    error ItemPaymentRequired(uint256 id);
    error ItemNotPaymentRequired(uint256 id);
    error AlreadyJoined(address player);
    error NotJoined(address player);
    error MaxPurchasesExceeded(uint256 id, uint256 max);
    error ShopDisabled();
    error MaintenanceMode();
    error AlreadyInMaintenance();
    error NotInMaintenance();
    error Unauthorized();
    error InvalidArrayLength();
    error LengthMismatch();
    error RenounceNotAllowed();
    // ---------------------------------------------------------------------
    // Events — emitted for every important state change
    // ---------------------------------------------------------------------
    event PlayerJoined(address indexed player, uint256 feePaid);
    event ItemPurchased(address indexed player, uint256 indexed itemId, uint256 price, bool free);
    event ItemAdded(uint256 indexed itemId, uint256 price, bool paymentRequired);
    event ItemUpdated(uint256 indexed itemId);
    event ItemRemoved(uint256 indexed itemId);
    event FeatureUpdated(bytes32 indexed featureId, bool enabled);
    event ConfigUpdated(bytes32 indexed configId, uint8 kind);
    event EntryFeeUpdated(uint256 oldFee, uint256 newFee);
    event TreasuryWithdrawn(address indexed to, uint256 amount);
    event AccessReset(address indexed player);
    event AccessEpochReset(uint256 indexed newEpoch);
    event MaintenanceEnabled(address account);
    event MaintenanceDisabled(address account);

    // ---------------------------------------------------------------------
    // Feature-flag IDs (keccak256 of human-readable names)
    // ---------------------------------------------------------------------
    bytes32 public constant FEATURE_ENTRY_FEE       = keccak256("EntryFeeEnabled");
    bytes32 public constant FEATURE_SHOP            = keccak256("ShopEnabled");
    bytes32 public constant FEATURE_INVENTORY       = keccak256("InventoryEnabled");
    bytes32 public constant FEATURE_SPECIAL_EVENTS  = keccak256("SpecialEventsEnabled");
    bytes32 public constant FEATURE_SEASON_PASS     = keccak256("SeasonPassEnabled");
    bytes32 public constant FEATURE_TOURNAMENT      = keccak256("TournamentEnabled");
    bytes32 public constant FEATURE_DAILY_REWARDS   = keccak256("DailyRewardsEnabled");
    bytes32 public constant FEATURE_REFERRAL        = keccak256("ReferralProgramEnabled");
    bytes32 public constant FEATURE_LEADERBOARD     = keccak256("LeaderboardRewardsEnabled");
    bytes32 public constant FEATURE_SECOND_TOWER    = keccak256("SecondTowerEnabled");

    // ---------------------------------------------------------------------
    // Configuration IDs (keccak256 of human-readable names)
    // ---------------------------------------------------------------------
    bytes32 public constant CONFIG_ENTRY_FEE        = keccak256("EntryFee");
    bytes32 public constant CONFIG_STARTING_COINS   = keccak256("StartingCoins");
    bytes32 public constant CONFIG_MAX_LIVES        = keccak256("MaxLives");
    bytes32 public constant CONFIG_DAILY_REWARD     = keccak256("DailyRewardAmount");
    bytes32 public constant CONFIG_SEASON_NUMBER    = keccak256("SeasonNumber");
    bytes32 public constant CONFIG_TREASURY         = keccak256("TreasuryAddress");
    bytes32 public constant CONFIG_USDC             = keccak256("USDCAddress");
    bytes32 public constant CONFIG_DOUBLE_XP        = keccak256("DoubleXP");
    bytes32 public constant CONFIG_MAINTENANCE      = keccak256("MaintenanceMode");
    bytes32 public constant CONFIG_ENEMY_MULTIPLIER = keccak256("EnemyMultiplier");
    bytes32 public constant CONFIG_REFERRAL_REWARD  = keccak256("ReferralReward");
    bytes32 public constant CONFIG_SHOP_VERSION     = keccak256("ShopVersion");
    bytes32 public constant CONFIG_ECONOMY_VERSION  = keccak256("EconomyVersion");
    bytes32 public constant CONFIG_GAME_VERSION     = keccak256("GameVersion");        // numeric (uint)
    bytes32 public constant CONFIG_GAME_VERSION_STR = keccak256("GameVersionStr");    // display string

    // Config value kinds (so a single generic getter can return any type)
    uint8 public constant KIND_NONE    = 0;
    uint8 public constant KIND_UINT    = 1;
    uint8 public constant KIND_ADDRESS = 2;
    uint8 public constant KIND_BOOL    = 3;
    uint8 public constant KIND_STRING  = 4;

    /// @notice Generic, typed configuration value.
    struct ConfigValue {
        uint8 kind;        // KIND_* discriminator
        uint256 asUint;    // numeric / boolean-as-uint payload
        address asAddress; // address payload
        bool asBool;       // boolean payload
        string asString;   // string payload
    }

    // ---------------------------------------------------------------------
    // Item (generic shop entry — NO gameplay-specific fields)
    // ---------------------------------------------------------------------
    struct Item {
        uint256 id;                    // unique id
        uint256 price;                 // USDC base units (6 decimals); 0 when free
        bool enabled;                  // owner can disable without redeploy
        bool paymentRequired;          // false => free claim
        uint256 maxPurchasesPerPlayer; // 0 => unlimited
        string metadataURI;            // off-chain metadata (JSON)
        string category;               // generic grouping label
    }

    /// @notice Input shape for adding items (keeps addItem / batch add uniform).
    struct ItemInput {
        uint256 id;
        uint256 price;
        bool enabled;
        bool paymentRequired;
        uint256 maxPurchasesPerPlayer;
        string metadataURI;
        string category;
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------
    /// @notice USDC is immutable — the only accepted payment token.
    IERC20 public immutable usdc;

    // Generic configuration registry
    mapping(bytes32 => ConfigValue) private _config;
    bytes32[] private _configKeys;
    mapping(bytes32 => bool) private _configExists;

    // Generic feature-flag registry
    mapping(bytes32 => bool) private _features;
    bytes32[] private _featureKeys;
    mapping(bytes32 => bool) private _featureExists;

    // Generic shop items
    mapping(uint256 => Item) private _items;
    uint256[] private _itemIds;
    mapping(uint256 => bool) private _itemExists;

    // Player state
    mapping(address => bool) public joinedPlayers;
    mapping(address => mapping(uint256 => bool)) public ownedItems;
    mapping(address => mapping(uint256 => uint256)) public purchaseCount;
    mapping(address => uint256[]) private _inventory;

    // Access-epoch reset (scalable alternative to per-player reset loops).
    // joinedPlayers is only valid when its recorded epoch equals the current one.
    uint256 private _currentEpoch;
    mapping(address => uint256) private _joinEpoch;

    // NOTE: The previous `_players` array + `resetAllAccess()` loop is removed.
    // Resetting everyone must never loop over all players (gas scales with
    // player count and is a DoS vector). The owner now bumps `_currentEpoch`,
    // invalidating every join in O(1). Always verify join via `hasJoined(player)`.

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------
    /// @dev Rejects any state-changing call during Emergency (paused) or Maintenance.
    modifier onlyUsable() {
        if (paused()) revert MaintenanceMode();
        if (_config[CONFIG_MAINTENANCE].asBool) revert MaintenanceMode();
        _;
    }

    /// @notice Restricts an action to players that have joined (epoch-aware).
    modifier onlyJoined() {
        if (!hasJoined(msg.sender)) revert NotJoined(msg.sender);
        _;
    }

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------
    /// @param usdcToken    USDC contract address on Arc Testnet.
    /// @param initialOwner Platform owner (receives ownership, can withdraw treasury).
    constructor(address usdcToken, address initialOwner) Ownable(initialOwner) {
        if (usdcToken == address(0)) revert ZeroAddress();
        if (initialOwner == address(0)) revert ZeroAddress();
        usdc = IERC20(usdcToken);

        // Seed discoverable configuration so frontends work immediately.
        _setAddressConfig(CONFIG_USDC, usdcToken);

        _setBoolConfig(FEATURE_SHOP, true);
        _setBoolConfig(FEATURE_INVENTORY, true);
        _setBoolConfig(FEATURE_SECOND_TOWER, true);

        _setUintConfig(CONFIG_ENTRY_FEE, 0);          // free by default
        _setUintConfig(CONFIG_STARTING_COINS, 150);
        _setUintConfig(CONFIG_MAX_LIVES, 20);
        _setUintConfig(CONFIG_DAILY_REWARD, 10);
        _setUintConfig(CONFIG_SEASON_NUMBER, 1);
        _setUintConfig(CONFIG_ENEMY_MULTIPLIER, 100);  // 100 == x1.00
        _setUintConfig(CONFIG_REFERRAL_REWARD, 5);
        _setUintConfig(CONFIG_SHOP_VERSION, 1);
        _setUintConfig(CONFIG_ECONOMY_VERSION, 1);
        _setUintConfig(CONFIG_GAME_VERSION, 1);        // numeric version
        _setStringConfig(CONFIG_GAME_VERSION_STR, "1.0.0"); // display string
        // NOTE: numeric and string versions now live in SEPARATE keys
        // (CONFIG_GAME_VERSION vs CONFIG_GAME_VERSION_STR) so neither overwrites
        // the other's storage slot — fixing a prior dual-write collision.
        _setBoolConfig(CONFIG_DOUBLE_XP, false);
        _setBoolConfig(CONFIG_MAINTENANCE, false);
        // NOTE: numeric and string versions now live in SEPARATE keys
        // (CONFIG_GAME_VERSION vs CONFIG_GAME_VERSION_STR) so neither overwrites
        // the other's storage slot — fixing a prior dual-write collision.
    }

    // =====================================================================
    // CONFIGURATION REGISTRY (generic, extensible)
    // =====================================================================
    function _trackKey(bytes32 id) private {
        if (!_configExists[id]) {
            _configKeys.push(id);
            _configExists[id] = true;
        }
    }

    function _setUintConfig(bytes32 id, uint256 v) private {
        ConfigValue storage c = _config[id];
        c.kind = KIND_UINT;
        c.asUint = v;
        c.asAddress = address(0);
        c.asBool = false;
        c.asString = "";
        _trackKey(id);
        emit ConfigUpdated(id, KIND_UINT);
    }

    function _setAddressConfig(bytes32 id, address v) private {
        if (v == address(0)) revert ZeroAddress();
        ConfigValue storage c = _config[id];
        c.kind = KIND_ADDRESS;
        c.asAddress = v;
        c.asUint = 0;
        c.asBool = false;
        c.asString = "";
        _trackKey(id);
        emit ConfigUpdated(id, KIND_ADDRESS);
    }

    function _setBoolConfig(bytes32 id, bool v) private {
        ConfigValue storage c = _config[id];
        c.kind = KIND_BOOL;
        c.asBool = v;
        c.asUint = v ? 1 : 0;
        c.asAddress = address(0);
        c.asString = "";
        _trackKey(id);
        emit ConfigUpdated(id, KIND_BOOL);
    }

    function _setStringConfig(bytes32 id, string memory v) private {
        ConfigValue storage c = _config[id];
        c.kind = KIND_STRING;
        c.asString = v;
        c.asUint = 0;
        c.asAddress = address(0);
        c.asBool = false;
        _trackKey(id);
        emit ConfigUpdated(id, KIND_STRING);
    }

    // Owner setters — all config is mutable, no redeploy needed.
    function setUintConfig(bytes32 id, uint256 value) external onlyOwner { _setUintConfig(id, value); }
    function setAddressConfig(bytes32 id, address value) external onlyOwner { _setAddressConfig(id, value); }
    function setBoolConfig(bytes32 id, bool value) external onlyOwner { _setBoolConfig(id, value); }
    function setStringConfig(bytes32 id, string calldata value) external onlyOwner { _setStringConfig(id, value); }

    /// @notice Dedicated entry-fee setter. Rejects zero to avoid an ambiguous
    ///         "free" state (use the EntryFee feature flag to make joining free).
    function updateEntryFee(uint256 newFee) external onlyOwner {
        if (newFee == 0) revert ZeroAmount();
        uint256 old = _config[CONFIG_ENTRY_FEE].asUint;
        _setUintConfig(CONFIG_ENTRY_FEE, newFee);
        emit EntryFeeUpdated(old, newFee);
    }

    /// @notice Set the treasury payout address (defaults to owner if unset).
    function setTreasuryAddress(address treasury) external onlyOwner {
        if (treasury == address(0)) revert ZeroAddress();
        _setAddressConfig(CONFIG_TREASURY, treasury);
    }

    // Generic read
    function getConfig(bytes32 id) external view returns (ConfigValue memory) { return _config[id]; }

    // Typed convenience reads
    function getUintConfig(bytes32 id) external view returns (uint256) { return _config[id].asUint; }
    function getAddressConfig(bytes32 id) external view returns (address) { return _config[id].asAddress; }
    function getBoolConfig(bytes32 id) external view returns (bool) { return _config[id].asBool; }
    function getStringConfig(bytes32 id) external view returns (string memory) { return _config[id].asString; }

    function getAllConfig() external view returns (bytes32[] memory ids, ConfigValue[] memory values) {
        ids = _configKeys;
        values = new ConfigValue[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            values[i] = _config[ids[i]];
        }
    }

    function configKeyCount() external view returns (uint256) { return _configKeys.length; }

    // =====================================================================
    // FEATURE FLAGS (generic registry)
    // =====================================================================
    function setFeature(bytes32 id, bool enabled) external onlyOwner {
        if (!_featureExists[id]) {
            _featureKeys.push(id);
            _featureExists[id] = true;
        }
        _features[id] = enabled;
        emit FeatureUpdated(id, enabled);
    }

    function isFeatureEnabled(bytes32 id) external view returns (bool) { return _features[id]; }

    function getAllFeatures() external view returns (bytes32[] memory ids, bool[] memory states) {
        ids = _featureKeys;
        states = new bool[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            states[i] = _features[ids[i]];
        }
    }

    function featureCount() external view returns (uint256) { return _featureKeys.length; }

    // =====================================================================
    // ENTRY SYSTEM
    // =====================================================================
    /// @notice Whether the game is free to join (feature off OR fee is zero).
    function isGameFree() external view returns (bool) {
        return !_features[FEATURE_ENTRY_FEE] || _config[CONFIG_ENTRY_FEE].asUint == 0;
    }

    /// @notice Current entry fee in USDC base units (6 decimals).
    function entryFee() external view returns (uint256) { return _config[CONFIG_ENTRY_FEE].asUint; }

    /// @notice Current access epoch. Joins recorded in an older epoch are invalid.
    function currentAccessEpoch() external view returns (uint256) { return _currentEpoch; }

    /// @notice Join the game. Pays the configured entry fee once (unless owner
    ///         resets access via an epoch bump or a per-player reset).
    function joinGame() external nonReentrant onlyUsable {
        if (hasJoined(msg.sender)) revert AlreadyJoined(msg.sender);

        uint256 fee = 0;
        if (_features[FEATURE_ENTRY_FEE] && _config[CONFIG_ENTRY_FEE].asUint > 0) {
            fee = _config[CONFIG_ENTRY_FEE].asUint;
            usdc.safeTransferFrom(msg.sender, address(this), fee);
        }

        joinedPlayers[msg.sender] = true;
        _joinEpoch[msg.sender] = _currentEpoch;
        emit PlayerJoined(msg.sender, fee);
    }

    /// @notice Authoritative join check. A join is valid only if its recorded
    ///         epoch matches the current epoch (so a global reset invalidates it).
    function hasJoined(address player) public view returns (bool) {
        return joinedPlayers[player] && _joinEpoch[player] == _currentEpoch;
    }

    /// @notice Owner can revoke a single player's join status (forces re-payment to rejoin).
    function resetPlayerAccess(address player) external onlyOwner {
        if (player == address(0)) revert ZeroAddress();
        joinedPlayers[player] = false;
        emit AccessReset(player);
    }

    /// @notice Owner can revoke everyone's join status in O(1) by advancing the
    ///         access epoch. Gas no longer depends on total player count.
    function resetAllAccess() external onlyOwner {
        unchecked { _currentEpoch += 1; }
        emit AccessEpochReset(_currentEpoch);
    }

    // =====================================================================
    // SHOP (generic items — no gameplay variables)
    // =====================================================================
    function _addItem(ItemInput calldata it) private {
        if (it.id == 0) revert InvalidItemId();
        if (_itemExists[it.id]) revert DuplicateItem(it.id);
        if (it.paymentRequired && it.price == 0) revert ZeroAmount();

        _items[it.id] = Item({
            id: it.id,
            price: it.price,
            enabled: it.enabled,
            paymentRequired: it.paymentRequired,
            maxPurchasesPerPlayer: it.maxPurchasesPerPlayer,
            metadataURI: it.metadataURI,
            category: it.category
        });
        _itemIds.push(it.id);
        _itemExists[it.id] = true;
        emit ItemAdded(it.id, it.price, it.paymentRequired);
    }

    function addItem(ItemInput calldata it) external onlyOwner { _addItem(it); }

    function addItems(ItemInput[] calldata list) external onlyOwner {
        for (uint256 i = 0; i < list.length; i++) _addItem(list[i]);
    }

    function _removeItemId(uint256 id) private {
        uint256 len = _itemIds.length;
        for (uint256 i = 0; i < len; i++) {
            if (_itemIds[i] == id) {
                _itemIds[i] = _itemIds[len - 1];
                _itemIds.pop();
                break;
            }
        }
    }

    function removeItem(uint256 id) external onlyOwner {
        if (!_itemExists[id]) revert ItemNotFound(id);
        delete _items[id];
        _itemExists[id] = false;
        _removeItemId(id);
        emit ItemRemoved(id);
    }

    function enableItem(uint256 id) external onlyOwner {
        if (!_itemExists[id]) revert ItemNotFound(id);
        _items[id].enabled = true;
        emit ItemUpdated(id);
    }

    function disableItem(uint256 id) external onlyOwner {
        if (!_itemExists[id]) revert ItemNotFound(id);
        _items[id].enabled = false;
        emit ItemUpdated(id);
    }

    function batchEnableItems(uint256[] calldata ids) external onlyOwner {
        for (uint256 i = 0; i < ids.length; i++) {
            if (!_itemExists[ids[i]]) revert ItemNotFound(ids[i]);
            _items[ids[i]].enabled = true;
            emit ItemUpdated(ids[i]);
        }
    }

    function batchDisableItems(uint256[] calldata ids) external onlyOwner {
        for (uint256 i = 0; i < ids.length; i++) {
            if (!_itemExists[ids[i]]) revert ItemNotFound(ids[i]);
            _items[ids[i]].enabled = false;
            emit ItemUpdated(ids[i]);
        }
    }

    function updateItemPrice(uint256 id, uint256 price) external onlyOwner {
        if (!_itemExists[id]) revert ItemNotFound(id);
        if (_items[id].paymentRequired && price == 0) revert ZeroAmount();
        _items[id].price = price;
        emit ItemUpdated(id);
    }

    function updateItemPrices(uint256[] calldata ids, uint256[] calldata prices) external onlyOwner {
        if (ids.length != prices.length) revert LengthMismatch();
        for (uint256 i = 0; i < ids.length; i++) {
            if (!_itemExists[ids[i]]) revert ItemNotFound(ids[i]);
            if (_items[ids[i]].paymentRequired && prices[i] == 0) revert ZeroAmount();
            _items[ids[i]].price = prices[i];
            emit ItemUpdated(ids[i]);
        }
    }

    function updateItemMetadata(uint256 id, string calldata metadataURI, string calldata category)
        external
        onlyOwner
    {
        if (!_itemExists[id]) revert ItemNotFound(id);
        _items[id].metadataURI = metadataURI;
        _items[id].category = category;
        emit ItemUpdated(id);
    }

    /// @notice Make an item free (no payment required).
    function makeItemFree(uint256 id) external onlyOwner {
        if (!_itemExists[id]) revert ItemNotFound(id);
        _items[id].paymentRequired = false;
        _items[id].price = 0;
        emit ItemUpdated(id);
    }

    /// @notice Require payment for an item (must already have a non-zero price).
    function requireItemPayment(uint256 id) external onlyOwner {
        if (!_itemExists[id]) revert ItemNotFound(id);
        if (_items[id].price == 0) revert ZeroAmount();
        _items[id].paymentRequired = true;
        emit ItemUpdated(id);
    }

    /// @notice Buy a generic item. Enforces shop feature, maintenance, item state,
    ///         per-player purchase caps, and performs the USDC transfer (CEI).
    function buyItem(uint256 itemId) external nonReentrant onlyUsable onlyJoined {
        if (itemId == 0) revert InvalidItemId();
        if (!_features[FEATURE_SHOP]) revert ShopDisabled();

        Item storage it = _items[itemId];
        if (!_itemExists[itemId]) revert ItemNotFound(itemId);
        if (!it.enabled) revert ItemDisabled(itemId);

        uint256 count = purchaseCount[msg.sender][itemId];
        if (it.maxPurchasesPerPlayer != 0 && count >= it.maxPurchasesPerPlayer) {
            revert MaxPurchasesExceeded(itemId, it.maxPurchasesPerPlayer);
        }

        bool free = !it.paymentRequired;
        if (it.paymentRequired) {
            // paymentRequired must always have a non-zero price; if not, the item
            // is misconfigured and must be fixed by the owner, not bought.
            if (it.price == 0) revert ItemPaymentRequired(itemId);
            // Checks-Effects-Interactions: transfer last.
            usdc.safeTransferFrom(msg.sender, address(this), it.price);
        }

        // Effects
        purchaseCount[msg.sender][itemId] = count + 1;
        if (!ownedItems[msg.sender][itemId]) {
            ownedItems[msg.sender][itemId] = true;
            _inventory[msg.sender].push(itemId);
        }

        emit ItemPurchased(msg.sender, itemId, it.price, free);
    }

    // Shop reads
    function getItem(uint256 id) external view returns (Item memory) {
        if (!_itemExists[id]) revert ItemNotFound(id);
        return _items[id];
    }

    function getAllItems() external view returns (Item[] memory) {
        Item[] memory out = new Item[](_itemIds.length);
        for (uint256 i = 0; i < _itemIds.length; i++) {
            out[i] = _items[_itemIds[i]];
        }
        return out;
    }

    function itemCount() external view returns (uint256) { return _itemIds.length; }

    function ownsItem(address player, uint256 id) external view returns (bool) {
        return ownedItems[player][id];
    }

    function getInventory(address player) external view returns (uint256[] memory) {
        return _inventory[player];
    }

    function getPurchaseCount(address player, uint256 id) external view returns (uint256) {
        return purchaseCount[player][id];
    }

    // =====================================================================
    // TREASURY
    // =====================================================================
    /// @notice All USDC is custodied by the contract. Owner withdraws to the
    ///         configured treasury address, falling back to the owner.
    /// @dev Reverts if `amount == 0` (no-op) or if the contract holds less than
    ///      `amount` (SafeERC20 reverts). Uses SafeERC20 — never raw transfer.
    function withdrawTreasury(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        address to = _config[CONFIG_TREASURY].asAddress;
        if (to == address(0)) to = owner();
        usdc.safeTransfer(to, amount);
        emit TreasuryWithdrawn(to, amount);
    }

    /// @notice Withdraw the entire USDC balance held by the contract in one call.
    /// @dev Convenience for the owner; reverts if there is nothing to withdraw.
    function withdrawAllTreasury() external onlyOwner nonReentrant {
        uint256 balance = usdc.balanceOf(address(this));
        if (balance == 0) revert ZeroAmount();
        address to = _config[CONFIG_TREASURY].asAddress;
        if (to == address(0)) to = owner();
        usdc.safeTransfer(to, balance);
        emit TreasuryWithdrawn(to, balance);
    }

    /// @notice Total USDC currently held by the contract.
    function treasuryBalance() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    /// @notice Rescue accidentally-sent non-USDC tokens. USDC must use withdrawTreasury /
    ///         withdrawAllTreasury. Prevents accidentally draining the USDC treasury.
    function rescueToken(IERC20 token, uint256 amount) external onlyOwner nonReentrant {
        if (address(token) == address(0)) revert ZeroAddress();
        if (address(token) == address(usdc)) revert InvalidUSDC();
        if (amount == 0) revert ZeroAmount();
        token.safeTransfer(owner(), amount);
    }

    // =====================================================================
    // EMERGENCY MODES
    // =====================================================================
    /// @notice Emergency pause — blocks ALL state-changing operations.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Disable ownership renouncement. The platform must always have an
    ///         explicit, accountable owner; renouncement would orphan the treasury.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceNotAllowed();
    }

    /// @notice Maintenance mode — disables purchases/joining, reads still work.
    function enableMaintenance() external onlyOwner {
        if (_config[CONFIG_MAINTENANCE].asBool) revert AlreadyInMaintenance();
        _setBoolConfig(CONFIG_MAINTENANCE, true);
        emit MaintenanceEnabled(msg.sender);
    }

    function disableMaintenance() external onlyOwner {
        if (!_config[CONFIG_MAINTENANCE].asBool) revert NotInMaintenance();
        _setBoolConfig(CONFIG_MAINTENANCE, false);
        emit MaintenanceDisabled(msg.sender);
    }

    function isMaintenance() external view returns (bool) { return _config[CONFIG_MAINTENANCE].asBool; }
}
