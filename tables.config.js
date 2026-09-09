// tables.config.js - per-table search configuration. Which tables get
// indexed, which fields are searched, and which fields come back verbatim for
// display. The first display field is the result title.
//
// Ship config matches the bundled sample dataset. A real FileMaker install
// overrides this shape via data/config.json (same keys, table names from the
// OData schema). Display fields are ALWAYS copied verbatim from the source
// row.

export const DEFAULT_TABLES = {
  people: {
    pk: "person_id",
    // `since` is a date column: a date or a date range typed in the search
    // field meets it. `price` in products is the number column.
    textFields: ["first", "last", "full_name", "email", "phone", "city", "country", "since", "note"],
    displayFields: ["full_name", "email", "phone", "city", "since"],
  },

  products: {
    pk: "product_id",
    textFields: ["name", "category", "price", "tier", "description"],
    displayFields: ["name", "category", "price", "tier"],
  },

  organizations: {
    pk: "org_id",
    textFields: ["name", "industry", "street", "city", "country"],
    displayFields: ["name", "industry", "city", "country"],
    // Employee names get joined into the source text at index time, so
    // searching a person's name can also surface their employer.
    textJoin: { table: "people", localKey: "org_id", remoteKey: "org_id", remoteField: "full_name", label: "people" },
  },
};
