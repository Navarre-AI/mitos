// saxml.js - FileMaker "Save a Copy as XML" (FMSaveAsXML) reader. Copied from
// Mitos (the reference implementation); Mitos adds the stored-calc flag on
// each field, which decides what is safe to pull.
//
// Why this exists: OData/Data API do NOT expose which FILE a base table lives
// in, its real developer name, its primary key, or its modification-timestamp
// field (verified – see GOTCHAS.md). All four are structural facts Mitos has
// to GUESS today (occurrence-suffix heuristics + an AI homing pass). The
// SaXML export carries every one of them as ground truth, per file.
//
// So this is deliberately a HINTS source, not a schema source: the live OData/
// Data API scan still discovers the tables and rows; hints only correct their
// home file, name, key, mod field, and comments after the fact (server.js
// applyHints). No new dependency – targeted regex, same style as fm.js.

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

// One <Field>…</Field> block -> the facts we care about.
function readField(block) {
  const attr = (n) => { const m = block.match(new RegExp(`^<Field\\b[^>]*\\b${n}="([^"]*)"`)); return m ? decodeXml(m[1]) : ""; };
  const name = attr("name");
  const datatype = attr("datatype");     // Text | Number | Date | Time | Timestamp | Container
  const fieldtype = attr("fieldtype");   // Normal | Calculated | Summary
  const comment = attr("comment");
  const ae = block.match(/<AutoEnter\b[^>]*\btype="([^"]*)"/);           // "" | SerialNumber | ModificationTimestamp | CreationTimestamp | Calculated | Looked_up …
  const autoEnter = ae ? ae[1] : "";
  const val = block.match(/<Validation\b[^>]*>/);
  const unique = val ? /\bunique="True"/.test(val[0]) : false;
  const notEmpty = val ? /\bnotEmpty="True"/.test(val[0]) : false;
  const global = /<Storage\b[^>]*\bglobal="True"/.test(block);
  // A Get(UUID…) auto-enter reads as type="Calculated" with the call in its calc.
  const calcUuid = autoEnter === "Calculated" && /Get\s*\(\s*UUID/i.test(block);
  // A calc that STORES its result is data at rest - cheap to serve, safe to
  // sync. SaXML marks it; OData cannot. Permissive match on purpose: absent
  // evidence means NOT stored, so nothing gets cheaper-looking than it is.
  const storedCalc = fieldtype === "Calculated" && /storeCalculationResults\s*=\s*"?true"?/i.test(block);
  return { name, datatype, fieldtype, comment, autoEnter, unique, notEmpty, global, calcUuid, storedCalc };
}

// Pick the primary key for one table from its fields. Order of trust:
// a real serial named like an id > any serial > a unique+notEmpty field >
// a Get(UUID) field > a unique field. Returns { field, kind } or null.
function pickPk(fields) {
  const idish = (f) => /(^|[^a-z])(id|uuid|pk|key|serial)([^a-z]|$)/i.test(f.name);
  const serials = fields.filter((f) => f.autoEnter === "SerialNumber");
  if (serials.length) { const s = serials.find(idish) || serials[0]; return { field: s.name, kind: "serial" }; }
  const uniq = fields.filter((f) => f.unique && f.notEmpty);
  if (uniq.length) { const u = uniq.find(idish) || uniq[0]; return { field: u.name, kind: "unique" }; }
  const uuid = fields.filter((f) => f.calcUuid && idish(f));
  if (uuid.length) return { field: uuid[0].name, kind: "uuid" };
  const anyUniq = fields.find((f) => f.unique);
  if (anyUniq) return { field: anyUniq.name, kind: "unique" };
  return null;
}

// The modification-timestamp field: an auto-enter ModificationTimestamp (the
// only kind FileMaker refreshes on every edit). Name varies (z_ModifiedTS,
// ModificationTimestamp, Modified…), so trust the auto-enter type, not the name.
function pickModField(fields) {
  const m = fields.find((f) => f.autoEnter === "ModificationTimestamp" && /timestamp/i.test(f.datatype));
  return m ? m.name : (fields.find((f) => f.autoEnter === "ModificationTimestamp")?.name || null);
}

// Parse ONE FMSaveAsXML document. Returns { file, tables:[{ name, pk, pkKind,
// modField, createField, comment, fields:[{n,t,c}] }] }.
export function parseSaxml(xml) {
  if (!/<FMSaveAsXML/i.test(xml)) throw new Error("Not a FileMaker Save-as-XML file (missing <FMSaveAsXML>).");
  const file = decodeXml((xml.match(/<FMSaveAsXML\b[^>]*\bFile="([^"]+)"/) || [])[1] || "unknown.fmp12");

  // Base-table comments live in the BaseTable catalog, keyed by table name.
  const tableComment = new Map();
  for (const m of xml.matchAll(/<BaseTable\b[^>]*\bname="([^"]+)"[^>]*\bcomment="([^"]*)"/g)) {
    const c = decodeXml(m[2]).trim(); if (c) tableComment.set(decodeXml(m[1]), c);
  }

  // The field catalog groups fields under a <BaseTableReference name="X"> plus
  // the <ObjectList> that follows it. That pairing is the authoritative
  // "these fields belong to base table X" mapping.
  const groupRe = /<BaseTableReference\b[^>]*\bname="([^"]+)"[^>]*?(?:\/>|>\s*<\/BaseTableReference>)\s*<ObjectList\b[^>]*>([\s\S]*?)<\/ObjectList>/g;
  const tables = [];
  const seen = new Set();
  let g;
  while ((g = groupRe.exec(xml))) {
    const name = decodeXml(g[1]);
    if (seen.has(name)) continue;
    const fieldBlocks = g[2].match(/<Field\b[\s\S]*?<\/Field>/g) || [];
    if (!fieldBlocks.length) continue;
    seen.add(name);
    const fields = fieldBlocks.map(readField).filter((f) => f.name);
    const pk = pickPk(fields);
    const create = fields.find((f) => f.autoEnter === "CreationTimestamp");
    tables.push({
      name,
      pk: pk ? pk.field : null,
      pkKind: pk ? pk.kind : null,
      modField: pickModField(fields),
      createField: create ? create.name : null,
      comment: tableComment.get(name) || null,
      // n name, t datatype, c comment, k fieldtype (Normal/Calculated/Summary),
      // s true when a calculation stores its result, g true for a global.
      fields: fields.map((f) => ({ n: f.name, t: f.datatype, k: f.fieldtype, ...(f.comment ? { c: f.comment } : {}), ...(f.storedCalc ? { s: true } : {}), ...(f.global ? { g: true } : {}) })),
    });
  }
  return { file, tables };
}

// Merge a freshly parsed file into an existing hints doc (replace same-file).
export function mergeHints(existing, parsed) {
  const files = (existing?.files || []).filter((f) => f.file !== parsed.file);
  files.push(parsed);
  files.sort((a, b) => a.file.localeCompare(b.file));
  return { source: "saxml", savedAt: new Date().toISOString(), files };
}

// Flatten hints into a match index: one entry per (file, table) carrying a
// lower-cased field-name Set for overlap matching against a live schema table.
export function hintIndex(hints) {
  const idx = [];
  for (const f of hints?.files || []) for (const t of f.tables || []) {
    idx.push({ file: f.file, table: t, names: new Set((t.fields || []).map((x) => x.n.toLowerCase())) });
  }
  return idx;
}

// Best SaXML table for a live schema table, by field-name overlap. Data API
// layouts expose only a SUBSET of a table's fields, so score by how much of the
// live set the candidate covers, then tie-break on closest field count (a
// sibling table – e.g. FieldLabor vs ShopLabor – shares the key columns but
// differs in size). `opts.preferFile` (the file Mitos already thinks the live
// table lives in) is the strongest disambiguator, so search that file first.
// Returns { file, table } or null. `schemaFieldNames` is live field names.
export function matchTable(schemaFieldNames, idx, opts = {}) {
  const live = new Set(schemaFieldNames.map((n) => String(n).toLowerCase()));
  if (live.size === 0) return null;
  const search = (cands) => {
    let best = null, bestScore = 0, bestGap = Infinity;
    for (const e of cands) {
      let shared = 0;
      for (const n of live) if (e.names.has(n)) shared++;
      if (!shared) continue;
      const score = shared / live.size;                    // coverage of the live set
      const gap = Math.abs((e.names.size || 0) - live.size); // closeness in size
      if (score > bestScore || (score === bestScore && gap < bestGap)) { best = e; bestScore = score; bestGap = gap; }
    }
    // Need a real majority AND a few shared names, so a couple of generic
    // columns (Notes, Status) can't mis-home a table.
    if (!best || bestScore < 0.5) return null;
    let shared = 0; for (const n of live) if (best.names.has(n)) shared++;
    if (shared < 3 && shared < live.size) return null;
    return { file: best.file, table: best.table };
  };
  if (opts.preferFile) {
    const pf = String(opts.preferFile).replace(/\.fmp12$/i, "").toLowerCase();
    const inFile = idx.filter((e) => e.file.replace(/\.fmp12$/i, "").toLowerCase() === pf);
    const hit = inFile.length ? search(inFile) : null;
    if (hit) return hit;
  }
  return search(idx);
}
