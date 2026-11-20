*For the FileMaker developer who wants a saved record in search right away. Optional: Mitos works without it. Back to the [kit guide](README.md).*

# Record updates, one record at a time

Out of the box, Mitos catches up with FileMaker on its timed sync. That's fine
for most files. If your users save a record and search for it a minute later,
add **Mitos - Record Changed** and the record is in search a few seconds after
it's committed. The timed sync keeps running as the safety net either way.

## What it does

On commit, the script tells Mitos "this table, this id". Mitos answers at once
and re-reads just that record from FileMaker behind the scenes, so nobody
waits on it.

On FileMaker Server or FileMaker Cloud, the script hands itself to the server
(Perform Script on Server, Wait for completion off), so users never see
"Transferring URL". On a file that isn't hosted, or is shared from FileMaker
Pro, it posts right there and that dialog can flash up.

## Add it to your file

1. Copy **Mitos - Record Changed** from the kit (**Mitos.fmp12**, it's hidden,
   so look in Script Workspace) into your file. Keep the name.
2. Paste your Mitos address into the `$url` line, in this form:
   `https://<your-mitos>.fly.dev/api/records/changed?key=<site password>`
3. On each layout whose table Mitos searches, add an **OnRecordCommit** layout
   trigger that runs it, with this parameter:

       JSONSetElement ( "{}" ;
         [ "table" ; "company" ; JSONString ] ;
         [ "id" ; Company::ID ; JSONString ]
       )

   Both are required: the table word from Mitos's Tables tab, and the primary
   key. With either empty the script does nothing. Numeric keys work as is;
   Mitos turns them into text.
4. A script that edits records without a commit trigger firing can call it the
   same way after it commits.

On the server, the script runs with the account's privileges, so that account
needs to be allowed **Insert from URL**.

## Did it work?

Open Mitos, **Log** tab, **Record updates**. Every call shows there: how many
records it updated or removed. A table Mitos doesn't index, or an id FileMaker
no longer has, shows on top in red.

## The call itself

    POST /api/records/changed?key=<site password>
    { "table": "<table>", "id": "<primary key>" }

Lists work too (`"ids": [...]`, `"deleted": [...]`). The full shape is in
[API.md](../API.md).
