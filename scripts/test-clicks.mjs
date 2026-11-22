// test-clicks.mjs - part of `npm test`. The click boost (R4) is a tiebreak and nothing
// more, checked here against a throwaway index: two records that score the same, the
// one people clicked after this query lists first; a record that is a better match still
// wins however many clicks the other has; with no clicks the order is what it was.
import fs from "fs";
import os from "os";
import path from "path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mitos-clicks-"));
const store = await import("../store.js");
const { search } = await import("../search.js");
await store.ensureIndexTable();
const row = (id, title, text = title) => ({ src_table: "t", record_id: id, display: JSON.stringify({ name: title }), source_text: text, search_text: ` ${text.toLowerCase()} `, title_text: ` ${title.toLowerCase()} `, nums: [], dates: [], emails: "", digits: "", content_hash: id, modified: null });
await store.upsertIndexRows("t", [
  row("A", "omen laptop"),
  row("B", "omen laptop"),
  row("C", "omen laptop"),
  row("W", "omen laptop", "omen laptop omen"),   // same words; not a better match, a tie too
  row("Z", "gaming notes", "an omen of a laptop"), // a weaker match: words only in the text
]);
const ids = async (clicks) => { const r = await search("omen laptop", { stageOverride: new Set(["exact"]), tablesCfg: { t: {} }, clicks }); return (r.groups[0]?.results || []).map((x) => x.id); };
const none = await ids(null);
const clicked = new Map([["t\u0000C", 3], ["t\u0000Z", 50]]);
const boosted = await ids(clicked);
const ok = boosted[0] === "C" && boosted.indexOf("Z") > boosted.indexOf("A") && none.join() === (await ids(new Map())).join() && none.indexOf("C") > 0;
console.log(`click boost: ${ok ? "pass" : "FAIL"} (no clicks ${none.join(",")}; C clicked 3 times, Z 50 times ${boosted.join(",")})`);
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
