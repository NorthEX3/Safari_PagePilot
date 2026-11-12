// Checks that every icon the manifest points to exists, is a PNG of the declared size, and that the design sources are present.
const fs = require("fs"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension/manifest.json"), "utf8"));
const pngSize = file => { const b = fs.readFileSync(file); assert.equal(b.slice(1, 4).toString(), "PNG", file + " is not a PNG"); return [b.readUInt32BE(16), b.readUInt32BE(20), b[25]]; };
const declared = { ...manifest.icons, ...(manifest.action?.default_icon || {}) };
for (const [size, rel] of Object.entries(declared)) {
  const file = path.join(root, "extension", rel);
  assert.ok(fs.existsSync(file), "missing " + rel);
  const [w, h, colorType] = pngSize(file);
  assert.deepEqual([w, h], [Number(size), Number(size)], `${rel} should be ${size}x${size}, is ${w}x${h}`);
  assert.equal(colorType, 6, `${rel} should have an alpha channel (rounded-corner icon)`);
  console.log(`  ok   ${rel}: ${w}x${h} PNG with alpha`);
}
const [w, h] = pngSize(path.join(root, "design/icon-1024.png"));
assert.deepEqual([w, h], [1024, 1024]); console.log("  ok   design/icon-1024.png: 1024x1024");
assert.ok(/<svg[\s\S]*<\/svg>/.test(fs.readFileSync(path.join(root, "design/icon.svg"), "utf8"))); console.log("  ok   design/icon.svg present (editable source)");
console.log("\nPASS: icon checks");
