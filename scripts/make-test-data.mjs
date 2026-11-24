// Fictional test data for Mitos, with traps planted on purpose.
//
// Writes four CSVs (People, Companies, Products, Orders) and an eval cases
// file whose right answers are known, because the generator planted them.
// Every name, address and number is made up. Seeded: the same seed gives
// the same files.
//
// Usage: node scripts/make-test-data.mjs [--out test-data] [--people 5000]
//        [--orders 20000] [--seed 7]
// Then import the CSVs into FileMaker (one table each), set the field types
// (DOB, OrderDate: date; Price, Total, Qty: number), tick the tables in
// Mitos, Sync, and run:  EVAL_CASES=test-data/cases.json npm run eval

import fs from "node:fs";
import path from "node:path";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const OUT = arg("out", "test-data");
const N_PEOPLE = Number(arg("people", 5000));
const N_ORDERS = Number(arg("orders", 20000));
let seed = Number(arg("seed", 7)) >>> 0;

// mulberry32: small, seeded, good enough for test data.
const rand = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (a) => a[Math.floor(rand() * a.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const pad = (n, w) => String(n).padStart(w, "0");

// --- Name pools ---------------------------------------------------------------
const FIRST = {
  en: ["James", "Mary", "John", "Patricia", "Michael", "Jennifer", "David", "Linda", "Richard", "Susan",
    "Joseph", "Karen", "Thomas", "Nancy", "Charles", "Lisa", "Daniel", "Sandra", "Mark", "Ashley",
    "Paul", "Emily", "Steven", "Donna", "Andrew", "Michelle", "Kenneth", "Carol", "Joshua", "Amanda",
    "Kevin", "Melissa", "Brian", "Deborah", "George", "Stephanie", "Timothy", "Rebecca", "Ronald", "Laura",
    "Jason", "Sharon", "Edward", "Cynthia", "Jeffrey", "Kathleen", "Ryan", "Amy", "Jacob", "Angela",
    "Gary", "Helen", "Nicholas", "Anna", "Eric", "Brenda", "Jonathan", "Pamela", "Stephen", "Nicole",
    "Larry", "Emma", "Justin", "Samantha", "Scott", "Katherine", "Brandon", "Christine", "Benjamin", "Debra"],
  es: ["José", "María", "Juan", "Lucía", "Carlos", "Sofía", "Javier", "Elena", "Miguel", "Carmen", "Diego", "Isabel"],
  pl: ["Krzysztof", "Agnieszka", "Piotr", "Małgorzata", "Tomasz", "Katarzyna", "Paweł", "Joanna", "Łukasz", "Żaneta"],
  zh: ["Wei", "Fang", "Jun", "Li", "Ming", "Xiu", "Hao", "Yan", "Lei", "Jing"],
};
const LAST = {
  en: ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Wilson", "Anderson",
    "Taylor", "Thomas", "Moore", "Jackson", "Martin", "Lee", "Thompson", "White", "Harris", "Clark",
    "Lewis", "Robinson", "Walker", "Young", "Allen", "King", "Wright", "Scott", "Torres", "Hill",
    "Green", "Adams", "Nelson", "Hall", "Campbell", "Mitchell", "Carter", "Roberts", "Phillips", "Evans",
    "Turner", "Parker", "Collins", "Edwards", "Stewart", "Morris", "Murphy", "Cook", "Rogers", "Morgan",
    "Cooper", "Peterson", "Reed", "Bailey", "Bell", "Kelly", "Howard", "Ward", "Cox", "Richardson",
    "Whitfield", "Halloran", "Umbridge", "Fairweather", "Blackwood", "Ashcombe", "Pemberton", "Holloway"],
  es: ["García", "Fernández", "López", "Martínez", "Sánchez", "Pérez", "Gómez", "Ruiz", "Díaz", "Moreno"],
  pl: ["Nowak", "Kowalski", "Wiśniewski", "Wójcik", "Kowalczyk", "Kamiński", "Lewandowski", "Zieliński"],
  zh: ["Wang", "Li", "Zhang", "Liu", "Chen", "Yang", "Huang", "Zhao", "Wu", "Zhou"],
};
// Greek people come as pairs: the Greek form and the Latin form a person
// might type. The Greek row is the record; the Latin form is the query.
const GREEK = [
  ["Γιώργος", "Giorgos"], ["Δημήτρης", "Dimitris"], ["Νίκος", "Nikos"], ["Μαρία", "Maria"],
  ["Ελένη", "Eleni"], ["Κατερίνα", "Katerina"], ["Γιάννης", "Giannis"], ["Σοφία", "Sofia"],
  ["Κώστας", "Kostas"], ["Αναστασία", "Anastasia"],
];
const GREEK_LAST = [
  ["Παπαδόπουλος", "Papadopoulos"], ["Παπαδοπούλου", "Papadopoulou"], ["Γεωργίου", "Georgiou"],
  ["Νικολάου", "Nikolaou"], ["Βασιλείου", "Vasileiou"], ["Ιωάννου", "Ioannou"], ["Μαυρίδης", "Mavridis"],
  ["Καραγιάννης", "Karagiannis"], ["Αντωνίου", "Antoniou"], ["Χατζηδάκης", "Chatzidakis"],
];
// Surnames that collide with product and company words: the robot vacuum
// trap ("robert bolt" found "Jet Bot AI+ Robot Vacuum", 2026-11-24).
const TRAP_LAST = ["Bolt", "Rose", "Mason", "Baker", "Jet", "Apple", "Ford", "Glass", "Stone", "Max"];
const CITIES = ["Portland", "Austin", "Denver", "Boston", "Seattle", "Chicago", "Rethymno", "Chania",
  "Heraklion", "Athens", "Madrid", "Kraków", "Shanghai", "London", "Dublin", "Lyon"];
// Nicknames Mitos's name table knows (names.config.js): nick -> formal.
const NICK = [["Bob", "Robert"], ["Bill", "William"], ["Peggy", "Margaret"], ["Liz", "Elizabeth"],
  ["Jim", "James"], ["Kate", "Katherine"], ["Dick", "Richard"], ["Tony", "Anthony"]];

const slug = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l").replace(/[^a-z]/gi, "").toLowerCase();
const typo = (w) => {
  // One slip: drop, double or swap a letter, never the first.
  const i = int(1, w.length - 2);
  const k = int(0, 2);
  if (k === 0) return w.slice(0, i) + w.slice(i + 1);
  if (k === 1) return w.slice(0, i) + w[i] + w.slice(i);
  return w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2);
};

// --- People -------------------------------------------------------------------
const people = [];
const cases = [];
const usedNames = new Set();
const usedPhones = new Set();
const addPerson = (first, last, extra = {}) => {
  const full = `${first} ${last}`;
  if (usedNames.has(full)) return null;
  usedNames.add(full);
  let phone;
  do phone = `+1 ${int(200, 989)} ${int(200, 989)} ${pad(int(0, 9999), 4)}`; while (usedPhones.has(phone.slice(-8)));
  usedPhones.add(phone.slice(-8));
  const id = `P${pad(people.length + 1, 5)}`;
  const y = int(1945, 2004), m = int(1, 12), d = int(1, 28);
  const p = {
    PersonID: id, FirstName: first, LastName: last, FullName: full,
    Email: `${slug(first)}.${slug(last)}${int(1, 99)}@example.${pick(["com", "org", "net"])}`,
    Phone: phone, City: pick(CITIES), DOB: `${m}/${d}/${y}`,
    Notes: extra.notes || "",
  };
  people.push(p);
  return p;
};

// Planted: nicknames. Formal name in the record, the nickname typed.
for (const [nick, formal] of NICK) {
  const last = pick(["Ashcombe", "Pemberton", "Holloway", "Fairweather", "Blackwood"]) + (rand() < 0.5 ? "" : "e");
  const p = addPerson(formal, last);
  if (p) cases.push({ section: "names", query: `${nick} ${last}`, kind: "text", table: "People", expectAny: [p.FullName] });
}
// Planted: Greek records found by their Latin spelling, and by Greek itself.
for (let i = 0; i < GREEK.length; i++) {
  const [gf, lf] = GREEK[i], [gl, ll] = GREEK_LAST[i];
  const p = addPerson(gf, gl);
  if (!p) continue;
  cases.push({ section: "greek", query: `${gf} ${gl}`, kind: "text", table: "People", expectAny: [p.FullName] });
  cases.push({ section: "greek", query: `${lf} ${ll}`, kind: "text", table: "People", expectAny: [p.FullName], why: "Latin spelling of a Greek name" });
}
// Planted: the trap surnames, and a query for a person who doesn't exist
// that must not pull in a product.
for (const last of TRAP_LAST) addPerson(pick(FIRST.en), last);
cases.push({ section: "traps", query: "robert bolt", kind: "text", table: "People", expectAny: [], notAny: ["Robot Vacuum", "Jet Bot"], why: "no Robert Bolt exists; a product must not stand in" });
cases.push({ section: "traps", query: "rose", kind: "text", table: "People", expectAny: ["Rose"] });

// The crowd.
const langs = ["en", "en", "en", "en", "es", "pl", "zh"];
while (people.length < N_PEOPLE) {
  const lang = pick(langs);
  if (rand() < 0.05) {
    const [gf] = pick(GREEK), [gl] = pick(GREEK_LAST);
    addPerson(gf, gl);
  } else addPerson(pick(FIRST[lang]), pick(LAST[lang]));
}
// Typo cases from the crowd: surnames of 7+ letters, unique full names.
const typoable = people.filter((p) => /^[A-Za-z]{7,}$/.test(p.LastName) && /^[A-Za-z]+$/.test(p.FirstName));
for (let i = 0; i < 8 && typoable.length; i++) {
  const p = typoable.splice(Math.floor(rand() * typoable.length), 1)[0];
  cases.push({ section: "typos", query: `${p.FirstName} ${typo(p.LastName)}`, kind: "text", table: "People", expectAny: [p.FullName] });
}
// Phone and email cases.
for (let i = 0; i < 3; i++) {
  const p = pick(people);
  cases.push({ section: "phone", query: p.Phone.slice(-8), kind: "phone", table: "People", expectAny: [p.FullName] });
  cases.push({ section: "email", query: p.Email, kind: "email", table: "People", expectAny: [p.FullName] });
}

// --- Companies ------------------------------------------------------------------
const COMPANY_WORDS = ["Harbor", "Summit", "Bluewater", "Granite", "Cedar", "Northwind", "Olive", "Aegean",
  "Ironbridge", "Meridian", "Copper", "Lantern", "Falcon", "Willow", "Keystone", "Orchard"];
const COMPANY_KINDS = ["Group", "Holdings", "Partners", "Logistics", "Clinic", "Foods", "Studio", "Supply", "Labs", "& Sons"];
const companies = [];
const usedCo = new Set();
while (companies.length < Math.max(200, Math.round(N_PEOPLE / 8))) {
  const name = rand() < 0.25
    ? `${pick(people).LastName} ${pick(COMPANY_KINDS)}`
    : `${pick(COMPANY_WORDS)} ${pick(COMPANY_KINDS)}`;
  if (usedCo.has(name)) continue;
  usedCo.add(name);
  companies.push({
    CompanyID: `C${pad(companies.length + 1, 4)}`, Name: name, City: pick(CITIES),
    Phone: `+1 ${int(200, 989)} ${int(200, 989)} ${pad(int(0, 9999), 4)}`,
    Website: `www.${slug(name)}.example`,
  });
}

// --- Products -------------------------------------------------------------------
const BRANDS = ["Jet", "Aero", "Nova", "Vertex", "Glide", "Pulse", "Rose", "Mason", "Baker's", "Stone"];
const ITEMS = [["Bot AI+ Robot Vacuum", 499, 1299], ["Bot Mini Robot Vacuum", 199, 399], ["Pro Blender", 79, 249],
  ["Max Air Fryer", 89, 199], ["One Kettle", 29, 79], ["Go Headphones", 49, 299], ["Glass Jar Set", 12, 39],
  ["Rose Gold Watch", 149, 599], ["Stone Baking Sheet", 19, 59], ["Bolt Cordless Drill", 79, 229],
  ["Ultra Laptop 14", 899, 2499], ["Air Desk Lamp", 25, 89], ["Pro Espresso Machine", 299, 1199]];
const products = [];
const usedProd = new Set();
let guard = 0;
while (products.length < 800 && guard++ < 20000) {
  const [item, lo, hi] = pick(ITEMS);
  const name = `${pick(BRANDS)} ${item} ${pick(["", "", "II", "S", "X", "2026", "Lite"])}`.trim();
  if (usedProd.has(name)) continue;
  usedProd.add(name);
  products.push({
    ProductID: `R${pad(products.length + 1, 4)}`, Name: name,
    SKU: `${slug(name).slice(0, 4).toUpperCase()}-${pad(int(0, 99999), 5)}`,
    Price: (int(lo * 100, hi * 100) / 100).toFixed(2),
  });
}
const prod0 = products[0];
cases.push({ section: "products", query: prod0.SKU, kind: "text", table: "Products", expectAny: [prod0.Name] });

// --- Orders ---------------------------------------------------------------------
const orders = [];
for (let i = 0; i < N_ORDERS; i++) {
  const p = pick(people), r = pick(products), qty = int(1, 4);
  const y = int(2019, 2026), m = int(1, 12), d = int(1, 28);
  orders.push({
    OrderNo: `SO-${pad(10001 + i, 6)}`, OrderDate: `${m}/${d}/${y}`, PersonID: p.PersonID,
    Customer: p.FullName, Product: r.Name, Qty: qty, Total: (Number(r.Price) * qty).toFixed(2),
    Status: pick(["Open", "Shipped", "Shipped", "Shipped", "Returned", "Cancelled"]),
  });
}
const o = orders[Math.floor(N_ORDERS / 2)];
cases.push({ section: "orders", query: o.OrderNo, kind: "text", table: "Orders", expectAny: [o.OrderNo] });

// --- Write ----------------------------------------------------------------------
fs.mkdirSync(OUT, { recursive: true });
const csv = (rows) => {
  const cols = Object.keys(rows[0]);
  const q = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(","), ...rows.map((r) => cols.map((c) => q(r[c])).join(","))].join("\n") + "\n";
};
for (const [name, rows] of [["People", people], ["Companies", companies], ["Products", products], ["Orders", orders]]) {
  fs.writeFileSync(path.join(OUT, `${name}.csv`), csv(rows));
  console.log(`${name}.csv  ${rows.length} rows`);
}
fs.writeFileSync(path.join(OUT, "cases.json"), JSON.stringify({
  note: "Generated by scripts/make-test-data.mjs. Table names are the FileMaker table names; rename here if yours differ.",
  cases,
}, null, 1) + "\n");
console.log(`cases.json  ${cases.length} cases`);
