// test-recency.mjs - part of `npm test`. The sample data has no modification
// timestamp, so the recency tiebreak is checked here against a throwaway index:
// two records with the same title and score, the newer one lists first; a
// record that is a better match still wins whatever its date.
import fs from "fs";
import os from "os";
import path from "path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mitos-recency-"));
const store = await import("../store.js");
const { parseQuery } = await import("../query.js");
await store.ensureIndexTable();
const row = (id, title, modified, text = title) => ({ src_table: "t", record_id: id, display: JSON.stringify({ name: title }), source_text: text, search_text: ` ${text.toLowerCase()} `, title_text: ` ${title.toLowerCase()} `, nums: [], dates: [], emails: "", digits: "", content_hash: id, modified });
await store.upsertIndexRows("t", [
  row("A", "omen 30l", "2024-01-01 10:00:00"),
  row("B", "omen 30l", "2026-05-01 10:00:00"),
  row("C", "omen 30l", null),
  row("D", "omen 30l bundle with a very long extra title", "2026-11-01 00:00:00"),
]);
const got = (await store.textSearch(parseQuery("omen 30l"), { perTable: 5 })).map((r) => r.record_id);
const ok = got.slice(0, 3).join() === "B,A,C" && got[3] === "D";
console.log(`recency tiebreak: ${ok ? "pass" : "FAIL"} (got ${got.join(",")}, want B,A,C,D)`);
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
