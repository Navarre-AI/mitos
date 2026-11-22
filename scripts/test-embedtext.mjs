// test-embedtext.mjs - part of `npm test`. What a vector is made from (R7): the meaning fields,
// not ids, numbers, dates, emails, phones or addresses; a record with nothing else still gets
// text; the vector key names the recipe so old vectors are never mixed with new ones.
import fs from "fs";
import os from "os";
process.env.DATA_DIR = fs.mkdtempSync(os.tmpdir() + "/mitos-embedtext-");
const { embedText, meaningLines } = await import("../stages.js");
const { vectorKeyFor } = await import("../embed.js");
const bad = [];
const eq = (what, got, want) => { if (got !== want) bad.push(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); };
const person = "person_id: P0201\nfirst: Giorgos\nlast: Marakis\nfull_name: Giorgos Marakis\nemail: g@example.com\nphone: +30 281 044 7712\ncity: Rethymno\nsince: 2021-06-14\nnote: Greek form of George";
eq("a person", embedText("people", person, "George Marakis\nGeorgios"), "people: Giorgos. Marakis. Giorgos Marakis. Rethymno. Greek form of George. George Marakis. Georgios");
eq("an organization", embedText("orgs", "name: Acme Systems\nindustry: Software\nstreet: 1 Main St\nZipCode: 97201\npeople: Matt Navarre, Bob Smith"), "orgs: Acme Systems. Software. Matt Navarre, Bob Smith");
eq("a product", embedText("products", "name: Canvas Sneakers\nprice: 49.99\ntier: 3\ndescription: Everyday shoes, 100% cotton\nSKU: AB-12345"), "products: Canvas Sneakers. Everyday shoes, 100% cotton");
eq("only numbers and dates", embedText("lines", "Amount: 12.50\nDate: 2020-01-01"), "lines: 12.50. 2020-01-01");
eq("timestamps and uuids", meaningLines("created: 2026-01-02T03:04:05Z\nref: 3f2b8c1e-1111-4222-8333-444455556666\ncomment: damaged on arrival").join("|"), "damaged on arrival");
eq("the key names the recipe", vectorKeyFor("openai", "text-embedding-3-small", 256) === vectorKeyFor("openai", "text-embedding-3-small", 512), false);
eq("the key carries the text recipe", /\/m\d+$/.test(vectorKeyFor("openai", "m", 256)), true);
console.log(`embed text: ${bad.length ? "FAIL\n  " + bad.join("\n  ") : "pass"}`);
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
process.exit(bad.length ? 1 : 0);
