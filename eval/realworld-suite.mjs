// realworld-suite.mjs - cases for the real-world benchmark (scripts/realworld.mjs).
// What a person types, and the record(s) they actually want, against the same
// sample data as `npm test`. Each case is run against Mitos and against the
// standard FileMaker model in eval/fm-baseline.mjs.
//
// Case fields:
//   group   the group it is reported under
//   q       what the user types
//   table   the table of the wanted record (FileMaker is given this table)
//   ids     the wanted record(s): ANY of them counts as "the right record"
//   set     true when ALL of `ids` are wanted (a range): completeness is also measured
//   ai      true when only a model stage (meaning, synonyms) could answer it
//   fm      "quick" (default, the search box) or { field } (a developer-built
//           find in one named field: ranges, ==, wildcards)
//   why     one line, shown in the report for the odd ones
//
// Truth is written by hand, or computed from the CSV for ranges (`W`), never
// taken from either search.

import { loadData } from "./fm-baseline.mjs";

const D = loadData();
const W = (table, pred) => D[table].rows.filter((r) => pred(r.row)).map((r) => r.id);
const C = [];
const add = (group, q, table, ids, extra = {}) => C.push({ group, q, table, ids: [].concat(ids), ...extra });

// ---- exact names -----------------------------------------------------------------------------
add("exact names", "Matt Navarre", "people", "P0001");
add("exact names", "Siobhan Murphy", "people", "P0007");
add("exact names", "Robert Whitfield", "people", "P0004");
add("exact names", "Margaret Halloran", "people", "P0005");
add("exact names", "Darren Umbridge", "people", "P0006");
add("exact names", "Mary Navarre", "people", "P0140");
add("exact names", "Elizabeth Smith", "people", "P0038");
add("exact names", "Patricia Miller", "people", "P0050");
add("exact names", "Wei Lindqvist", "people", "P0137");
add("exact names", "Jennifer Vasilakis", "people", "P0172");
add("exact names", "Taras Brown", "people", "P0064");
add("exact names", "Whitfield", "people", "P0004");
add("exact names", "Umbridge", "people", "P0006");
add("exact names", "Halloran", "people", "P0005");
add("exact names", "Murphy", "people", "P0007");
add("exact names", "Quietwater Maritime Salvage", "organizations", "O0002");
add("exact names", "Phoenix Cardiac Clinic", "organizations", "O0003");
add("exact names", "Atlas Trust", "organizations", "O0022");
add("exact names", "Hank's Used Nuclear Reactor Parts", "organizations", "O0001");
add("exact names", "Ironclad Systems", "organizations", "O0048");
add("exact names", "Sterling Associates", "organizations", "O0032");
add("exact names", "Canvas Sneakers", "products", "PR0001");
add("exact names", "iPhone 15 Pro", "products", "PR0010");
add("exact names", "Reserve Geisha 100g", "products", "PR0016");
add("exact names", "Carbon Road Bike", "products", "PR0019");
add("exact names", "Studio Reference", "products", "PR0028");

// ---- typos: one letter wrong -----------------------------------------------------------------
add("typo: one letter wrong", "Robart Whitfield", "people", "P0004");
add("typo: one letter wrong", "Darran Umbridge", "people", "P0006");
add("typo: one letter wrong", "Halloren", "people", "P0005");
add("typo: one letter wrong", "Siobhan Murphi", "people", "P0007");
add("typo: one letter wrong", "Quietwatar Maritime Salvage", "organizations", "O0002");
add("typo: one letter wrong", "Phoenix Cardiak Clinic", "organizations", "O0003");
add("typo: one letter wrong", "Canvas Sneekers", "products", "PR0001");
add("typo: one letter wrong", "Reserve Geesha", "products", "PR0016");
add("typo: one letter wrong", "Studio Referense", "products", "PR0028");
add("typo: one letter wrong", "Chromebuk 11", "products", "PR0021");

// ---- typos: letters swapped ------------------------------------------------------------------
add("typo: letters swapped", "Wihtfield", "people", "P0004");
add("typo: letters swapped", "Umbirdge", "people", "P0006");
add("typo: letters swapped", "Hallroan", "people", "P0005");
add("typo: letters swapped", "Murpyh", "people", "P0007");
add("typo: letters swapped", "Matt Navrare", "people", "P0001");
add("typo: letters swapped", "Phoneix Cardiac Clinic", "organizations", "O0003");
add("typo: letters swapped", "Quitewater Salvage", "organizations", "O0002");
add("typo: letters swapped", "Cnavas Sneakers", "products", "PR0001");
add("typo: letters swapped", "Ultraboko 14", "products", "PR0022");

// ---- typos: a letter missing -----------------------------------------------------------------
add("typo: letter missing", "Whitfild", "people", "P0004");
add("typo: letter missing", "Siobhn Murphy", "people", "P0007");
add("typo: letter missing", "Halloan", "people", "P0005");
add("typo: letter missing", "Umbrdge", "people", "P0006");
add("typo: letter missing", "Matt Navare", "people", "P0001");
add("typo: letter missing", "Maritme Salvage", "organizations", "O0002");
add("typo: letter missing", "Phoenx Cardiac", "organizations", "O0003");
add("typo: letter missing", "Sneakrs", "products", "PR0001");
add("typo: letter missing", "Chromebok", "products", "PR0021");
add("typo: letter missing", "Carbon Rod Bike", "products", "PR0019");

// ---- typos: phonetic spelling ----------------------------------------------------------------
add("typo: phonetic", "Shavon Murphy", "people", "P0007");
add("typo: phonetic", "Shivawn Murphy", "people", "P0007");
add("typo: phonetic", "Papadopolous", "people", W("people", (r) => r.last === "Papadopoulos"), { why: "any Papadopoulos counts: there are six" });
add("typo: phonetic", "Kostas Garsia", "people", ["P0019", "P0094"]);
add("typo: phonetic", "Jenifer Costa", "people", "P0037");
add("typo: phonetic", "Anastasya Bianchi", "people", "P0012");
add("typo: phonetic", "Astrid Anderson", "people", W("people", (r) => r.first === "Astrid" && r.last === "Andersson"));
add("typo: phonetic", "Gheisha Reserve", "products", "PR0016");
add("typo: phonetic", "Maria Mueller", "people", "P0014", { why: "ue for u with umlaut" });
add("typo: phonetic", "Maria Muller", "people", "P0014", { why: "accent dropped: FileMaker ignores accents" });

// ---- nicknames -------------------------------------------------------------------------------
add("nicknames", "Bob Whitfield", "people", "P0004");
add("nicknames", "Peg Halloran", "people", "P0005");
add("nicknames", "Maggie Halloran", "people", "P0005");
add("nicknames", "Mike Smith", "people", "P0086");
add("nicknames", "Mick Costa", "people", "P0041");
add("nicknames", "Liz Smith", "people", "P0038");
add("nicknames", "Beth Davis", "people", "P0048");
add("nicknames", "Pat Miller", "people", "P0050", { why: "Pat is a prefix of Patricia: FileMaker finds it too" });
add("nicknames", "Jim Navarre", "people", "P0009");
add("nicknames", "Rob Brown", "people", "P0026", { why: "Rob is a prefix of Robert: FileMaker finds it too" });
add("nicknames", "Sophie Smith", "people", "P0023");
add("nicknames", "Dave Smith", "people", "P0166");
add("nicknames", "Costas Garcia", "people", ["P0019", "P0094"]);
add("nicknames", "Nick Nikolaidis", "people", ["P0011", "P0080"]);
add("nicknames", "Matt Petrov", "people", "P0040", { why: "Mathieu is Matt in French: probably not in the name list" });
add("nicknames", "Jenny Costa", "people", "P0037", { why: "Jenny for Jennifer: probably not in the name list" });

// ---- partial words ---------------------------------------------------------------------------
add("partial words", "Whitf", "people", "P0004");
add("partial words", "Umbri", "people", "P0006");
add("partial words", "Siobh", "people", "P0007");
add("partial words", "Matt Nav", "people", "P0001");
add("partial words", "Rob Whit", "people", "P0004");
add("partial words", "Eliz Smi", "people", "P0038");
add("partial words", "Quietw", "organizations", "O0002");
add("partial words", "Cardi", "organizations", "O0003");
add("partial words", "Ironcl", "organizations", "O0048");
add("partial words", "Sneak", "products", "PR0001");
add("partial words", "Workst", "products", "PR0023");
add("partial words", "Ultrab", "products", ["PR0022"], { why: "Ultraboost Pro also starts this way" });
add("partial words", "tfield", "people", "P0004", { why: "the middle of a word: FileMaker matches word starts only" });
add("partial words", "water salvage", "organizations", "O0002", { why: "the end of Quietwater" });

// ---- multi-word with an extra or wrong word -------------------------------------------------
add("extra or wrong word", "Robert Whitfield Paris", "people", "P0004", { why: "wrong city (he is in Lyon)" });
add("extra or wrong word", "Matt Navarre CEO", "people", "P0001");
add("extra or wrong word", "Siobhan Murphy Dublin", "people", "P0007");
add("extra or wrong word", "find Bob Whitfield please", "people", "P0004");
add("extra or wrong word", "contact Matt Navarre", "people", "P0001");
add("extra or wrong word", "Canvas Sneakers black", "products", "PR0001");
add("extra or wrong word", "Reserve Geisha beans", "products", "PR0016");
add("extra or wrong word", "Phoenix Cardiac Clinic Boston", "organizations", "O0003");
add("extra or wrong word", "Atlas Trust Inc", "organizations", "O0022");
add("extra or wrong word", "the new iPhone 15 Pro", "products", "PR0010");
add("extra or wrong word", "Over-ear ANC headphones black", "products", "PR0027");
add("extra or wrong word", "Robert Whitfeld Lyon", "people", "P0004", { why: "typo plus a right extra word" });
add("extra or wrong word", "Darren Umbridge Greece", "people", "P0006", { why: "a right extra word: FileMaker is fine" });
add("extra or wrong word", "Navarre Matt Athens", "people", "P0001", { why: "any order, right extra word: FileMaker is fine" });

// ---- number ranges and single prices ---------------------------------------------------------
const rng = (lo, hi) => W("products", (r) => +r.price >= lo && +r.price <= hi);
add("numbers", "1099", "products", "PR0010");
add("numbers", "$1099", "products", "PR0010");
add("numbers", "599", "products", "PR0009");
add("numbers", "45", "products", "PR0001");
add("numbers", "65", "products", ["PR0002", "PR0016"], { why: "two products cost 65" });
add("numbers", "2400", "products", "PR0023");
add("numbers", "900...1500", "products", rng(900, 1500), { set: true, fm: { field: "price" } });
add("numbers", "20...50", "products", rng(20, 50), { set: true, fm: { field: "price" } });
add("numbers", "500...600", "products", rng(500, 600), { set: true, fm: { field: "price" } });
add("numbers", "$300...$400", "products", rng(300, 400), { set: true, fm: { field: "price" } });
add("numbers", "<10", "products", W("products", (r) => +r.price < 10), { set: true, fm: { field: "price" } });
add("numbers", ">3000", "products", W("products", (r) => +r.price > 3000), { set: true, fm: { field: "price" } });
add("numbers", "<=100", "products", W("products", (r) => +r.price <= 100), { set: true, fm: { field: "price" }, why: "ten products: more than the five a table shows" });
add("numbers", "under 100", "products", W("products", (r) => +r.price < 100), { fm: { field: "price" }, ai: true, why: "words for a range; FileMaker is given the field find with the same text, which it cannot read" });

// ---- dates -----------------------------------------------------------------------------------
const since = (pred) => W("people", (r) => pred(r.since));
add("dates", "2019-03-04", "people", "P0001");
add("dates", "3/4/2019", "people", "P0001");
add("dates", "3/19/2019", "people", "P0086");
add("dates", "2026-05-20", "people", "P0087");
add("dates", "5/20/26", "people", "P0087", { why: "two-digit year" });
add("dates", "19.3.2019", "people", "P0086", { why: "day first with dots; 19 cannot be a month" });
add("dates", "March 4, 2019", "people", "P0001", { why: "month named in words" });
add("dates", "4 March 2019", "people", "P0001", { why: "month named in words, day first" });
add("dates", "10/31/2018", "people", "P0005");
add("dates", "3/2019", "people", ["P0001", "P0086"], { set: true });
add("dates", "2012-12", "people", "P0160");
add("dates", "May 2026", "people", ["P0002", "P0087"], { set: true, why: "month named in words" });
add("dates", "1/1/2026...3/31/2026", "people", since((d) => d >= "2026-01-01" && d <= "2026-03-31"), { set: true, fm: { field: "since" } });
add("dates", "2026-01-01...2026-01-31", "people", since((d) => d >= "2026-01-01" && d <= "2026-01-31"), { set: true, fm: { field: "since" } });
add("dates", "11/2025...12/2025", "people", since((d) => d >= "2025-11-01" && d <= "2025-12-31"), { set: true, fm: { field: "since" } });
add("dates", ">=2026-05-01", "people", since((d) => d >= "2026-05-01"), { set: true, fm: { field: "since" } });
add("dates", "<2013-01-01", "people", since((d) => d < "2013-01-01"), { set: true, fm: { field: "since" }, why: "twelve people: more than five" });
add("dates", "2019", "people", since((d) => d.startsWith("2019")), { why: "any of the fourteen people who joined in 2019" });

// ---- phones ----------------------------------------------------------------------------------
add("phones", "+11 629 773 9565", "people", "P0001");
add("phones", "(629) 773-9565", "people", "P0001", { why: "same number, American punctuation" });
add("phones", "773-9565", "people", "P0001");
add("phones", "6297739565", "people", "P0001", { why: "all digits, no spaces" });
add("phones", "9565", "people", "P0001", { why: "last four digits" });
add("phones", "1152", "people", "P0004", { why: "last four digits" });
add("phones", "+41 969 174 1152", "people", "P0004");
add("phones", "969.174.1152", "people", "P0004", { why: "dots" });
add("phones", "9691741152", "people", "P0004", { why: "no country code, no spaces" });
add("phones", "270 350 7054", "people", "P0007");
add("phones", "7054", "people", "P0007");

// ---- emails ----------------------------------------------------------------------------------
add("emails", "matt.navarre@example.com", "people", "P0001");
add("emails", "robert.whitfield@example.com", "people", "P0004");
add("emails", "whitfield@example.com", "people", "P0004", { why: "half the address" });
add("emails", "siobhan.murphy@", "people", "P0007", { why: "the start of an address" });
add("emails", "john.costa24@example.com", "people", "P0024");
add("emails", "john.costa163", "people", "P0163");
add("emails", "MATT.NAVARRE@EXAMPLE.COM", "people", "P0001", { why: "capitals" });
add("emails", "mary.navarre140", "people", "P0140");
add("emails", "darren.umbrige@example.com", "people", "P0006", { why: "typo in an address" });

// ---- cross-table: the user does not know which table -----------------------------------------
// FileMaker is handed the right table. Mitos searches all of them.
add("cross-table", "Hank", "organizations", "O0001");
add("cross-table", "Cardiac", "organizations", "O0003");
add("cross-table", "Geisha", "products", "PR0016");
add("cross-table", "Nuclear", "organizations", "O0001");
add("cross-table", "Ultrabook", "products", "PR0022");
add("cross-table", "Halcyon", "organizations", "O0020");
add("cross-table", "Pioneer Partners", "organizations", "O0004");
add("cross-table", "iPhone", "products", ["PR0009", "PR0010"], { why: "two iPhones: either is fine" });
add("cross-table", "Robert Whitfield Bluewater Industries", "organizations", "O0030", { why: "the employer, found through the employee's name (a related field)" });

// ---- semantic: meaning, synonyms, descriptions (need AI) ---------------------------------------
add("meaning (AI)", "cheap coffee", "products", ["PR0012", "PR0013"], { ai: true, why: "budget coffee" });
add("meaning (AI)", "noise cancelling headphones", "products", "PR0027", { ai: true });
add("meaning (AI)", "laptop for video editing", "products", ["PR0024", "PR0023"], { ai: true });
add("meaning (AI)", "cellphone", "products", W("products", (r) => r.category === "Phones"), { ai: true });
add("meaning (AI)", "bike for commuting", "products", "PR0017", { ai: true });
add("meaning (AI)", "earphones", "products", ["PR0025", "PR0026"], { ai: true });
add("meaning (AI)", "luxury shoes", "products", ["PR0005", "PR0006"], { ai: true });
add("meaning (AI)", "iced coffee", "products", "PR0015", { ai: true });
add("meaning (AI)", "electric bicycle", "products", "PR0020", { ai: true });
add("meaning (AI)", "heart clinic", "organizations", "O0003", { ai: true });
add("meaning (AI)", "healthcare company in Portland", "organizations", "O0003", { ai: true });
add("meaning (AI)", "boat salvage company", "organizations", "O0002", { ai: true });
add("meaning (AI)", "the Ukrainian version of Matt", "people", "P0003", { ai: true });
add("meaning (AI)", "running shoes", "products", "PR0003", { why: "Running Trainers: shoes... the words are in the record; no AI needed" });
add("meaning (AI)", "coffee pods", "products", "PR0014", { why: "the words are in the description; no AI needed" });
add("meaning (AI)", "Greek Matt", "people", "P0002", { why: "the words are in the note; no AI needed" });

// ---- non-Latin -------------------------------------------------------------------------------
// The sample holds Greek (P0002, P0201), Cyrillic (P0003) and Chinese (P0202) records.
add("non-Latin", "Ματίας", "people", "P0002");
add("non-Latin", "Ναβάρ", "people", "P0002");
add("non-Latin", "ΜΑΤΙΑΣ ΝΑΒΑΡ", "people", "P0002", { why: "capitals, no accents" });
add("non-Latin", "ματιας", "people", "P0002", { why: "accent dropped" });
add("non-Latin", "Метт Навар", "people", "P0003");
add("non-Latin", "метт", "people", "P0003", { why: "lower case" });
add("non-Latin", "Γιώργος Μαράκης", "people", "P0201");
add("non-Latin", "γιωργος μαρακης", "people", "P0201", { why: "tonos dropped" });
add("non-Latin", "乔治", "people", "P0202");
add("non-Latin", "乔", "people", "P0202", { why: "a partial Chinese name" });
add("meaning (AI)", "george maraki", "people", "P0202", { ai: true, why: "shares only George with the query; needs the search notes and the AI phase" });

// ---- FileMaker find operators typed into a search box ---------------------------------------
add("find operators", "\"Cardiac Clinic\"", "organizations", "O0003", { why: "a quoted phrase: quick find supports it" });
add("find operators", "==Matt Navarre", "people", "P0001", { fm: { field: "full_name" }, why: "exact match, in a developer-built find" });
add("find operators", "Whit*", "people", "P0004", { fm: { field: "last" }, why: "wildcard, in a developer-built find" });
add("find operators", "Matt Navar*", "people", "P0001", { fm: { field: "full_name" }, why: "wildcard, in a developer-built find" });

export const CASES = C;
