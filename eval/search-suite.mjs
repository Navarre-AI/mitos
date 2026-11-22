// search-suite.mjs - the cases for `npm test` (scripts/test.mjs). Written
// against sample-data/*.csv, so every case names a definite record by id.
//
// Fields (all but group/q optional):
//   level   "must" (default) fails the run; "should" is reported only. A
//           "should" case is either aspirational or a known search bug (see why).
//   kind    what the front door must read the input as (string or array)
//   table + ids [+ rank]   one of `ids` must be in that table's group within
//           the top `rank` (default 1)
//   all     every id must be in `table` within the top `rank` (default 5)
//   exact   the table's group must be exactly this set of ids
//   notTables  tables that must not appear (type routing)
//   notIds  ids that must not appear anywhere
//   merged  { ids, n }: one of ids in the merged list's first n (default 3)
//   first   id that must be merged[0] (the very first row shown)
//   balance { tables, n }: each table has a row in the merged first n
//   tableFirst  the table that must be groups[0] (the first block shown)
//   cap     no table group may hold more than this many rows
//   best    an id: Best Match is flagged and is that record.
//           null: Best Match must NOT be flagged (a close call).
//   pctOrder  true: in every list the shown % never goes up top to bottom
//   empty   true: nothing may come back
//   why     one line, shown with a failure

const C = [];
const add = (group, q, spec = {}) => C.push({ group, q, ...spec });

// ---- names: whole names and single words, people ----
add("names", "Murphy", { kind: "text", table: "people", ids: ["P0007"] });
add("names", "Siobhan", { table: "people", ids: ["P0007"] });
add("names", "Siobhan Murphy", { table: "people", ids: ["P0007"], best: "P0007" });
add("names", "matt nav", { table: "people", ids: ["P0001"] });
add("names", "Matt Navarre", { table: "people", ids: ["P0001"], best: "P0001" });
add("names", "Mary Navarre", { table: "people", ids: ["P0140"], best: "P0140" });
add("names", "Umbridge", { table: "people", ids: ["P0006"] });
add("names", "Whitfield", { table: "people", ids: ["P0004"] });
add("names", "MATT NAVARRE", { table: "people", ids: ["P0001"], why: "case is ignored" });
add("names", "  matt   navarre  ", { table: "people", ids: ["P0001"], why: "extra spaces are ignored" });
add("names", "Ματίας", { table: "people", ids: ["P0002"] });
add("names", "Hank", { table: "organizations", ids: ["O0001"], best: "O0001" });
add("names", "\"Cardiac Clinic\"", { table: "organizations", ids: ["O0003"], why: "a quoted phrase stays together" });
add("names", "cardiac", { table: "organizations", ids: ["O0003"] });

// ---- nicknames: the name table maps short forms to formal ones ----
add("nicknames", "Bob Whitfield", { table: "people", ids: ["P0004"], best: "P0004" });
add("nicknames", "Peg Halloran", { table: "people", ids: ["P0005"], best: "P0005" });
add("nicknames", "Mike Smith", { table: "people", ids: ["P0086"] });
add("nicknames", "Liz Smith", { table: "people", ids: ["P0038"] });
add("nicknames", "Pat Miller", { table: "people", ids: ["P0050"] });
add("nicknames", "Jim Navarre", { table: "people", ids: ["P0009"] });
add("nicknames", "Rob Brown", { table: "people", ids: ["P0026"] });
add("nicknames", "Sophie Smith", { table: "people", ids: ["P0023"], why: "Sophie is Sofia" });
add("nicknames", "Matthew Navarre", { table: "people", ids: ["P0001"] });
add("nicknames", "Dave Davis", { level: "should", table: "people", ids: ["P0048", "P0166"], rank: 5, why: "Dave is David; only people named Davis or David match, but the first rows are Raj and Chloe Davis (a Davis with no David ahead of David Davis-less rows)" });
add("nicknames", "Nick Nikolaidis", { level: "should", table: "people", ids: ["P0011", "P0080"], rank: 3, why: "Nick is Nikos in Greek data; not in the name table" });
add("nicknames", "Whitfield Bob", { table: "people", ids: ["P0004"], why: "order of words does not matter" });

// ---- typos and close spellings (the fuzzy stage) ----
add("typos", "Daren Umbrige", { table: "people", ids: ["P0006"], why: "two slips" });
add("typos", "Shavon Murphy", { table: "people", ids: ["P0007"] });
add("typos", "Shavon", { table: "people", ids: ["P0007"], why: "phonetic spelling" });
add("typos", "Wittfield", { table: "people", ids: ["P0004"] });
add("typos", "Kostas Garca", { table: "people", all: ["P0019", "P0094"], rank: 3 });
add("typos", "Mueller", { table: "people", ids: ["P0014", "P0030", "P0130", "P0145", "P0147"], rank: 5, why: "ue for u-umlaut" });
add("typos", "Papadopolous", { table: "people", ids: ["P0010", "P0045", "P0047", "P0058", "P0192"], rank: 5 });
add("typos", "Hanks Used Nuclear", { table: "organizations", ids: ["O0001"], why: "missing apostrophe and a stray s" });
add("typos", "Quietwatter Salvage", { table: "organizations", ids: ["O0002"], level: "should", why: "doubled letter in a two-word name" });
add("typos", "Pheonix Cardiac", { table: "organizations", ids: ["O0003"], level: "should", why: "swapped vowels" });
add("typos", "Reserve Gheisha", { table: "products", ids: ["PR0016"], level: "should" });
add("typos", "Canvass Sneakers", { table: "products", ids: ["PR0001"] });
add("typos", "Chromebok", { table: "products", ids: ["PR0021"], level: "should" });

// ---- Last, First ----
add("last-first", "Whitfield, Robert", { table: "people", ids: ["P0004"], best: "P0004" });
add("last-first", "Navarre, Matt", { table: "people", ids: ["P0001"], best: "P0001" });
add("last-first", "Halloran, Margaret", { table: "people", ids: ["P0005"] });
add("last-first", "Navarre, Mary", { table: "people", ids: ["P0140"] });
add("last-first", "Whitfield, Bob", { table: "people", ids: ["P0004"], why: "Last, First with a nickname" });
add("last-first", "Navarre Matt", { table: "people", ids: ["P0001"], why: "no comma" });

// ---- numbers and ranges (products.price) ----
add("numbers", "45", { kind: "number", table: "products", ids: ["PR0001"] });
add("numbers", "$65", { table: "products", ids: ["PR0002", "PR0016"], rank: 2 });
add("numbers", "1099", { kind: "number", table: "products", ids: ["PR0010"], best: "PR0010", notTables: ["people", "organizations"] });
add("numbers", "40...70", { kind: "range", exact: ["PR0001", "PR0002", "PR0016"], table: "products", notTables: ["people", "organizations"] });
add("numbers", ">2000", { kind: "range", exact: ["PR0019", "PR0020", "PR0023", "PR0024"], table: "products", notTables: ["people", "organizations"] });
add("numbers", "<10", { kind: "range", exact: ["PR0012"], table: "products", notTables: ["people", "organizations"] });
add("numbers", "<=45", { kind: "range", table: "products", ids: ["PR0012"], notTables: ["people", "organizations"], why: "a range lists the lowest value first, so the cheapest (8) leads and the list stops at five" });
add("numbers", "1.5", { empty: true, level: "should", why: "no price or date is 1.5" });
add("numbers", "16", { table: "products", ids: ["PR0013"], rank: 3, level: "should", why: "price 16 should outrank phone numbers that happen to contain 16" });

// ---- dates and date ranges (people.since) ----
add("dates", "3/4/2019", { kind: "date", exact: ["P0001"], table: "people", notTables: ["products"] });
add("dates", "2019-03-04", { kind: "date", exact: ["P0001"], table: "people" });
add("dates", "2026-05-20", { exact: ["P0087"], table: "people" });
add("dates", "5/20/2026", { exact: ["P0087"], table: "people", why: "20 cannot be a month, so mdy" });
add("dates", "19.3.2019", { kind: "date", exact: ["P0086"], table: "people", why: "19 cannot be a month, so the data decides" });
add("dates", "4.3.2019", { kind: "date", exact: ["P0171"], table: "people", why: "both parts fit a month, the configured order decides" });
add("dates", "3/1/2026...3/31/2026", { kind: "daterange", exact: ["P0004", "P0089"], table: "people", notTables: ["products"] });
add("dates", "2026-01-01...2026-01-31", { kind: "daterange", exact: ["P0006", "P0091", "P0176"], table: "people" });
add("dates", ">=2026-05-01", { kind: "daterange", all: ["P0002", "P0087", "P0172"], table: "people", notTables: ["products"] });
add("dates", "2019", { table: "people", ids: ["P0001"], rank: 5, why: "a year reaches into date fields" });

// ---- months ----
add("months", "3/2019", { kind: "date", exact: ["P0001", "P0086"], table: "people" });
add("months", "2019-03", { exact: ["P0001", "P0086"], table: "people" });
add("months", "2026-05", { exact: ["P0002", "P0087"], table: "people" });
add("months", "1/2026", { exact: ["P0006", "P0091", "P0176"], table: "people" });
add("months", "March 2019", { kind: "date", exact: ["P0001", "P0086"], table: "people", why: "a month name with a year is a month range" });
add("months", "June 2026", { kind: "date", exact: ["P0172"], table: "people" });

// ---- phones (last four digits, whole numbers) ----
add("phones", "+11 629 773 9565", { kind: "phone", exact: ["P0001"], table: "people", notTables: ["products", "organizations"] });
add("phones", "773-9565", { kind: "phone", table: "people", ids: ["P0001"] });
add("phones", "6297739565", { table: "people", ids: ["P0001"], why: "a long digit run is also a phone number" });
add("phones", "9565", { kind: "number", table: "people", ids: ["P0001"], best: "P0001" });
add("phones", "1152", { table: "people", ids: ["P0004"], best: "P0004" });
add("phones", "7054", { table: "people", ids: ["P0007"] });
add("phones", "+41 969 174 1152", { kind: "phone", table: "people", ids: ["P0004"], best: "P0004" });
add("phones", "5-20-2026", { level: "should", kind: "date", table: "people", ids: ["P0087"], why: "dashes read as a phone number, not a date" });

// ---- emails ----
add("emails", "matt.navarre@example.com", { kind: "email", exact: ["P0001"], table: "people", best: "P0001" });
add("emails", "robert.whitfield@", { kind: "email", table: "people", ids: ["P0004"] });
add("emails", "whitfield@example.com", { kind: "email", table: "people", ids: ["P0004"] });
add("emails", "matt.navarre@", { kind: "email", table: "people", ids: ["P0001"], notTables: ["products", "organizations"] });
add("emails", "john.costa24", { table: "people", ids: ["P0024"], best: "P0024", why: "the number in an address picks the one John Costa" });
add("emails", "@example.com", { level: "should", kind: "email", table: "people", rank: 5, ids: ["P0001", "P0002", "P0003", "P0004", "P0005"], why: "a bare domain is read as words, not as an email" });

// ---- multi-word ----
add("multi-word", "Reserve Geisha", { table: "products", ids: ["PR0016"], best: "PR0016" });
add("multi-word", "Over-ear ANC", { table: "products", ids: ["PR0027"], best: "PR0027" });
add("multi-word", "iPhone 15", { table: "products", ids: ["PR0010"], best: "PR0010" });
add("multi-word", "Atlas & Co", { table: "organizations", ids: ["O0005"], best: "O0005" });
add("multi-word", "Matt Navarre", { table: "organizations", ids: ["O0040"], rank: 1, why: "employee names are joined into the employer's text" });
add("multi-word", "Hank's Used Nuclear Reactor Parts", { table: "organizations", ids: ["O0001"] });
add("multi-word", "Espresso Pods", { table: "products", ids: ["PR0014"] });

// ---- the % shown and the order agree (U2): never up as you read down a list ----
add("multi-word", "gaming laptop", { pctOrder: true, why: "shown % is the sort key" });
add("multi-word", "john costa", { pctOrder: true });
add("multi-word", "bob whitfeld", { pctOrder: true, why: "close spellings mixed with exact rows" });
add("multi-word", "navarre bluewater", { pctOrder: true });
add("multi-word", "wireless noise cancelling headphones", { pctOrder: true });

// ---- multi-table balance (the Canon rule): every table with a hit shows, no table floods ----
add("balance", "Navarre", { balance: { tables: ["people", "organizations"], n: 6 }, cap: 6, why: "five exact rows plus the one close-spelling row the list may add" });
add("balance", "Bluewater", { cap: 6, table: "organizations", all: ["O0012", "O0040", "O0030"], rank: 5 });
add("balance", "Greece", { balance: { tables: ["people", "organizations"], n: 4 }, cap: 5 });
add("balance", "Matt", { balance: { tables: ["people", "organizations"], n: 5 }, merged: { ids: ["P0001"], n: 3 } });
add("balance", "john costa", { balance: { tables: ["people", "organizations"], n: 4 }, cap: 5 });
add("balance", "45", { balance: { tables: ["people", "products"], n: 3 }, merged: { ids: ["PR0001"], n: 3 } });
add("balance", "Whitfield", { merged: { ids: ["P0004"], n: 2 } });

// ---- type routing: a typed input searches only the tables that have that type ----
add("routing", "40...70", { kind: "range", notTables: ["people", "organizations"] });
add("routing", "3/1/2026...3/31/2026", { kind: "daterange", notTables: ["products", "organizations"] });
add("routing", ">=2026-05-01", { kind: "daterange", notTables: ["products", "organizations"] });
add("routing", "3/2019", { kind: "date", notTables: ["products", "organizations"] });
add("routing", "matt.navarre@example.com", { kind: "email", notTables: ["products", "organizations"] });
add("routing", "1099", { kind: "number", notTables: ["people", "organizations"], why: "1099 is not in any phone number or date" });
add("routing", "nonsense", { kind: "text", empty: true });

// ---- Best Match: the plain gap rule. A clear winner is flagged, a close call is not ----
add("best", "Bob Whitfield", { best: "P0004" });
add("best", "Peg Halloran", { best: "P0005" });
add("best", "1099", { best: "PR0010", why: "the only record with that number" });
add("best", "Navarre", { best: null, why: "six people share the name" });
add("best", "john costa", { best: null, why: "three John Costas" });
add("best", "Bluewater", { best: null, why: "six organizations start with it" });
add("best", "Atlas", { best: null, why: "Atlas Trust and Atlas & Co are close" });
add("best", "iphone", { best: null, why: "iPhone 13 and iPhone 15 Pro" });
add("best", "40...70", { best: null, why: "a range has no single best" });

// ---- table order: the table whose record is the right answer comes first ----
// Tables are meant to be ordered by their real best score. Today tied top rows
// fall back to the table name, so organizations beat people beat products.
add("table-order", "Whitfield", { table: "people", ids: ["P0004"], tableFirst: "people", level: "should", why: "an employer found only through an employee's name (score 6.9) is listed before the person (15.9)" });
add("table-order", "Siobhan Murphy", { table: "people", ids: ["P0007"], tableFirst: "people", level: "should", why: "same: employer joined text listed before the person" });
add("table-order", "Matt Navarre", { table: "people", ids: ["P0001"], tableFirst: "people", level: "should", why: "same: Bluewater Group listed before Matt Navarre" });
add("table-order", "Bob Whitfield", { table: "people", ids: ["P0004"], tableFirst: "people", level: "should", why: "same" });
add("table-order", "Navarre", { table: "people", ids: ["P0001", "P0009", "P0032", "P0043", "P0140", "P0156"], tableFirst: "people", level: "should", why: "twelve-point person rows sit under five-point organization rows" });
add("table-order", "45", { table: "products", ids: ["PR0001"], tableFirst: "products", level: "should", why: "a price of 45 (number field) should lead phone numbers that merely contain 45" });
add("table-order", "16", { table: "products", ids: ["PR0013"], tableFirst: "products", level: "should", why: "same as 45" });
add("table-order", "Hank", { table: "organizations", ids: ["O0001"], tableFirst: "organizations" });
add("table-order", "Atlas & Co", { table: "organizations", ids: ["O0005"], tableFirst: "organizations" });
add("table-order", "Reserve Geisha", { table: "products", ids: ["PR0016"], tableFirst: "products" });
add("table-order", "773-9565", { table: "people", ids: ["P0001"], tableFirst: "people" });
add("table-order", "iPhone 15", { table: "products", ids: ["PR0010"], tableFirst: "products" });

// ---- long queries: one extra word must not empty the list ----
// Every word has to match today, so a query with a stray word ("please",
// "person") returns nothing from the exact stage. The first rows have all
// their words in the record (must work); the rest add one word the record does
// not carry (should work: the ranking review's "most words" fallback).
add("long", "Matt Navarre Athens Greece primary", { table: "people", ids: ["P0001"] });
add("long", "Robert Whitfield Lyon France", { table: "people", ids: ["P0004"] });
add("long", "Siobhan Murphy Athens Greece", { table: "people", ids: ["P0007"] });
add("long", "Hank's Used Nuclear Reactor Parts Rome Italy", { table: "organizations", ids: ["O0001"] });
add("long", "Quietwater Maritime Salvage Rethymno", { table: "organizations", ids: ["O0002"] });
add("long", "Phoenix Cardiac Clinic Portland USA Healthcare", { table: "organizations", ids: ["O0003"] });
add("long", "Canvas Sneakers shoes budget", { table: "products", ids: ["PR0001"] });
add("long", "Over-ear ANC headphones", { table: "products", ids: ["PR0027"] });
add("long", "Reserve Geisha coffee", { table: "products", ids: ["PR0016"] });
add("long", "find Bob Whitfield please", { table: "people", ids: ["P0004"], pctOrder: true, why: "two filler words, zero exact results" });
add("long", "contact Matt Navarre", { table: "people", ids: ["P0001"], pctOrder: true, why: "one filler word, zero exact results" });
add("long", "Matt Navarre person", { table: "people", ids: ["P0001"] });
add("long", "Robert Whitfield Basel", { table: "people", ids: ["P0004"] });
add("long", "Atlas Trust company", { table: "organizations", ids: ["O0022"] });
add("long", "Reserve Geisha coffee beans", { table: "products", ids: ["PR0016"], pctOrder: true, why: "two stray words: the most-words fallback" });

add("long", "find Bob Whitfield please", { best: "P0004", why: "filler words dropped, then it is a plain Bob Whitfield" });
add("long", "Bob Whitfield purple monkey", { table: "people", ids: ["P0004"], pctOrder: true, why: "most words: two of four" });
add("long", "purple monkey dishwasher", { empty: true, why: "three words nobody has: most-words needs two matches, finds none" });
add("long", "zzqx please", { empty: true, why: "a filler word never makes a match" });

// ---- 1.2 find-more (R9) ----
add("months", "March 4, 2019", { kind: "date", exact: ["P0001"], table: "people" });
add("months", "4 March 2019", { kind: "date", exact: ["P0001"], table: "people" });
add("months", "Mar 4th 2019", { kind: "date", exact: ["P0001"], table: "people" });
add("months", "May 2026", { kind: "date", exact: ["P0002", "P0087"], table: "people" });
add("months", "May", { kind: "text", why: "a month name alone stays a word (a person can be called May)" });
add("emails", "darren.umbrige@example.com", { table: "people", ids: ["P0006"], pctOrder: true, why: "a slip inside an address" });
add("emails", "totally.unknown@nowhere.org", { empty: true, why: "no address is close" });
add("nicknames", "Rob Whit", { table: "people", ids: ["P0004"], why: "word starts" });
add("nicknames", "Maria Muller", { table: "people", ids: ["P0014"], why: "accents typed plain" });
add("nicknames", "Matt Petrov", { table: "people", ids: ["P0040"], why: "Mathieu is Matt, from the name list" });
add("typos", "Shivawn Murphy", { table: "people", ids: ["P0007"], why: "a phonetic spelling, from the name list" });
add("operators", "==Matt Navarre", { table: "people", exact: ["P0001"], best: "P0001", why: "== means the title is exactly this" });
add("operators", "==Matt", { empty: true, why: "no title is exactly Matt, and no look-alikes" });
add("operators", "Whit*", { table: "people", ids: ["P0004"] });
add("operators", "W*field", { table: "people", ids: ["P0004"], why: "* inside a word" });
add("operators", "\"Matt Navarre\"", { table: "people", ids: ["P0001"] });
add("operators", "*field", { table: "people", ids: ["P0004"], why: "leading * is inside-a-word" });

// ---- 1.2 field weights (R6) ----
add("weights", "Matt Navarre", { table: "people", ids: ["P0001"], rank: 1, pctOrder: true, why: "the name in the title field beats the same words only in a note" });
add("weights", "Matt Navarre", { table: "people", all: ["P0001", "P0002", "P0003"], rank: 5, why: "the two rows whose note says Matt Navarre are still listed, below" });
// Recency (R6) is a tiebreak on a modification stamp the sample data does not have: scripts/test-recency.mjs.

export const CASES = C;
