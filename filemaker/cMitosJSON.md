# cMitosJSON: one field decides what a record means

Mitos can guess which fields of a table are worth indexing. The guess is
adequate and it is still a guess: it cannot reach related data, it cannot know
which fields matter to your users, and on a wide table it reads far more than
it needs.

The alternative is one unstored calculation field, named **cMitosJSON**, that
returns a JSON object. When Mitos sees that field on a table, it reads THAT
FIELD ONLY and ignores its own guessing.

## Why this is the better shape

- **You decide what a record is.** Related data, computed summaries, a parent
  name, a list of child items: anything a calculation can reach.
- **The pull gets small and fast.** Mitos asks for one field instead of every
  field, so the server evaluates one calculation per record instead of all of
  them. On a calculation-heavy table this is the difference between a sync
  that finishes and a sync that times out.
- **No layout is needed**, and no extra privileges beyond `fmodata`.

## The field

Add to each table you want indexed:

- **Name:** `cMitosJSON`
- **Type:** Calculation, result **Text**
- **Storage:** Unstored (this is important: it must reflect the record now)

Build the JSON with `JSONSetElement`, never by hand. FileMaker does not honor
backslash escapes in string literals, so a hand-typed JSON string is wrong the
moment a value contains a quote.

    JSONSetElement ( "{}" ;
        [ "name"     ; Person::Full Name        ; JSONString ] ;
        [ "email"    ; Person::Email            ; JSONString ] ;
        [ "city"     ; Person::City             ; JSONString ] ;
        [ "employer" ; Organization::Name       ; JSONString ] ;
        [ "_display" ;
            JSONSetElement ( "{}" ;
                [ "Name"     ; Person::Full Name  ; JSONString ] ;
                [ "Email"    ; Person::Email      ; JSONString ] ;
                [ "Employer" ; Organization::Name ; JSONString ] ) ;
            JSONObject ]
    )

## The reserved keys

| Key | Meaning |
|---|---|
| `_display` | An object copied **verbatim** into the result row. This is what the user sees. Never AI text. |
| `_id` | Overrides the record id Mitos stores. Defaults to the table's primary key. |

Every other key is search material: it is fed to the enrichment pass and
embedded. Keys are visible to the enrichment prompt, so name them in plain
words (`employer`, not `c_org_nm_calc`).

## Rules of thumb

- Put in what a person might **search for**, not everything the record holds.
- Numbers and dates embed poorly. A price is worth including; an internal
  serial is not.
- A record whose `cMitosJSON` is empty, or does not return a JSON object, is
  **skipped and counted** in the sync log. It is never half-indexed.
- Changing the calculation changes the text, so those records re-enrich on the
  next sync. That is the intended behavior and it costs only the rows that
  actually changed.

## What Mitos will not do

Mitos does **not** create this field for you. The OData API can add plain
fields to a table, but it cannot create a calculation field: there is no
formula parameter in the API. A calculation is defined in FileMaker Pro, or by
an FMUpgradeTool patch, or by pasting clipboard XML.

Source: Claris OData API Guide, "Add fields into a table".
