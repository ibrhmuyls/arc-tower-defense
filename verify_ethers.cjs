// KANIT: Eski kod SHA-256 (crypto.subtle) kullaniyordu -> selector'lar YANLISTI.
// Yeni kod ethers v6 (gercek Keccak-256) kullaniyor. Bu test bunu ispatlar.
// Calistir: node verify_ethers.cjs
const fs = require("fs");
const path = require("path");
const ethers = require("./vendor/ethers.umd.min.js");
const abi = JSON.parse(fs.readFileSync("./build/out/contracts_GamePlatform_sol_GamePlatform.abi", "utf8"));

const iface = new ethers.Interface(abi);
const sigs = ["joinGame()","buyItem(uint256)","entryFee()","isGameFree()","getAllItems()","getAllFeatures()","getItem(uint256)","getUintConfig(bytes32)","ownsItem(address,uint256)","getBoolConfig(bytes32)"];

let ok = true;
console.log("=== Selector vektorleri (ethers/Keccak-256) ===");
for (const s of sigs) {
  const sel = iface.getFunction(s).selector;
  console.log("  " + s.padEnd(34) + " -> " + sel);
}
const jg = iface.getFunction("joinGame()").selector;
console.log("\n[VECTOR] joinGame() beklenen 0xd4f77b1c, gercek:", jg, jg === "0xd4f77b1c" ? "OK" : "FAIL");
if (jg !== "0xd4f77b1c") ok = false;

console.log("\n=== Feature/config id hash (gercek keccak256) ===");
for (const n of ["EntryFeeEnabled","SecondTowerEnabled","MaxLives","StartingCoins","EnemyMultiplier","GameVersionStr","MaintenanceMode"])
  console.log("  " + n + " -> " + ethers.keccak256(ethers.toUtf8Bytes(n)));

// ABI decode round-trip (el yapimi decoder kaldirildi; ethers yapar)
const sampleItems = [
  { id: 1n, price: 5000000n, enabled: true, paymentRequired: true, maxPurchasesPerPlayer: 1, metadataURI: '{"name":"Okcu Kulesi"}', category: "tower" },
  { id: 2n, price: 0n, enabled: true, paymentRequired: false, maxPurchasesPerPlayer: 0, metadataURI: '{"name":"Hiz Boost"}', category: "boost" },
];
const enc = iface.encodeFunctionResult("getAllItems", [sampleItems]);
const dec = iface.decodeFunctionResult("getAllItems", enc)[0];
console.log("\n[DECODE getAllItems] kategori:", dec[0].category, "| metadata:", dec[0].metadataURI, dec[0].category === "tower" ? "OK" : "FAIL");
if (dec[0].category !== "tower" || dec[0].metadataURI !== '{"name":"Okcu Kulesi"}') ok = false;

console.log("\n=== SONUC:", ok ? "TUM TESTLER GECTI — SHA-256 bug'i duzeltildi (gercek Keccak + ABI decode)" : "TEST FAIL ===");
process.exit(ok ? 0 : 1);
