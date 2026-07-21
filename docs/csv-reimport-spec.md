# CSV Re-import Spec

Design for making the user's exported CSV the source of truth on re-import. Covers the current
export format (has ID column) and release 1.0.0 exports (no ID column). **Implemented** on
`fix/csv-reimport`: planning in `client/src/utils/importCsv.ts` (`buildImportPlan`), application in
`db.applyImportPlan` behind `POST /api/applications/import`.

## Principles

- The excel file the user edits is the **source of truth**: its values win, its email list wins.
- Import is an **upsert** — it never deletes an application merely because it is absent from the file.
- A gmail message id belongs to **exactly one application**.
- Every email id present in the file lands in `synced_emails`, so the next gmail sync skips them.
- All matching is resolved before any write; ambiguity resolves toward CREATE (a visible duplicate
  is safe; a silent wrong-target update is not).

## Pre-validation (before matching, before the modal)

- An application id cell must be a positive integer (`/^[1-9]\d*$/` — SQLite
  `INTEGER PRIMARY KEY AUTOINCREMENT`). Anything else (blank, text, zero, negative, decimal) is
  treated as **no id** and the row falls through to rules 2–4.
- Email message ids must be non-empty hex; malformed entries are dropped (parser already does this).
- **Reject the whole file** when any application id or any email message id appears more than once
  (nulls/blanks exempt) — whether across rows or twice within a single Emails cell. The error names
  each duplicated id and the rows/companies involved, e.g. "email `19f1a6…` appears in rows 62 and
  76 (Distyl, Distyl AI) — remove it from all but one row." The user resolves duplicates in excel;
  the human decides which application keeps a shared email, and which stage/date an email carries.
  - Known consequence: an export taken **before** this feature ships can legitimately contain a
    shared email id and will be rejected until the user fixes the file. This is the one-time
    normalization path for legacy data.

## Matching — one signal per row, strict order

A row is matched by exactly one rule; a lower rule never overrides a higher one.

1. **id matches an application on the board** → **UPDATE** that exact application.
2. **any of the row's email ids are held by existing applications** → **UPDATE** the **primary
   holder** — the application holding the most of the row's email ids (tie → oldest / smallest id).
   - Strip the row's emails from every other holder (email uniqueness).
   - Row email ids held by no application are attached as new.
   - **Id adoption:** if the row carries a (foreign) id and that id is free on the board,
     `UPDATE applications SET id = <file id>` on the holder so the row converges to rule 1 on the
     next import. If the id is taken by another app, keep the DB id. (Safe: no other table
     references application ids.)
3. **no id, no emails** → **company + role** fallback using the existing normalized comparison
   (case-insensitive), and only when unambiguous on **both** sides — exactly one candidate on the
   board and exactly one row in the file with that key. Otherwise CREATE. This path exists solely
   for 1.0.0 email-less rows.
4. **nothing matched** → **CREATE**, preserving the row's id when present and free (SQLite accepts
   explicit ids and advances the autoincrement sequence past them); autoincrement id otherwise.
   Re-imports of the same file then hit rule 1.

## Update semantics

- The row's values replace the application's, field by field, **only where changed**; an identical
  row is a no-op.
- **The row's email list fully replaces the application's email list** — including removals.
- Non-CSV columns are preserved on update: `external_id` fallback, `company_domain` fallback,
  `gmail_thread_id`, `fast_apply` / `confirmed` slot flags, `awaiting_application`, `created_at`.
  (Implementation: PATCH the matched app; never delete-and-recreate.)

## Deletion guard

After **all** rows' strips are resolved:

- Delete an application only if it **became** empty in this import — it had emails before and has
  none now. An application that was already email-less (manual entry, email-less import) is never
  deleted.
- An application matched by any row (by id, emails, or fallback) is never deleted, even if
  stripped to empty.

## Execution

1. Parse → pre-validate → match every row → build the complete mutation plan (updates, creates
   with explicit ids, id adoptions, strips, deletions). **No writes during planning.**
2. Show the confirm modal; on confirmation the whole plan goes in **one API call**, applied in a
   single server-side transaction — partial failure rolls back everything.
3. The import endpoint and gmail sync are mutually exclusive via a server-wide in-memory lock
   (single-process server): sync in progress → import returns "sync running, try again"; import in
   progress → sync waits. Keeps the plan from going stale between confirm and apply.
4. Mark every email id present in the file in `synced_emails` (`INSERT OR IGNORE` — genuine sync
   records are preserved), unconditionally.

## Confirm modal

- **Update & Add** applies the full plan, with an explicit warning: "will overwrite the listed
  applications with the file's values, including their email lists."
- **Add Only** creates unmatched rows only — **zero** updates, strips, deletions, or id adoptions
  of existing applications. A create that only exists because its target was claimed by an earlier
  row (conflict fallback) is excluded too, and only the added rows' emails are marked synced.
- Enumerates every destructive step per application:
  - "moves email X from *Distyl* to *Distyl AI*"
  - "deletes *Distyl* (no emails left)"
- Flags **suspicious id matches**: an id-matched row that carries emails NONE of which the target
  holds AND a different company — the signature of a file from a different database whose id landed
  on an unrelated app. An email-less row is never flagged (a plain company correction is the normal
  spreadsheet fix). The diff display is the user's chance to cancel.
- Result modal reports: Added / Updated / Merged (deleted) / Unchanged.

## Documented limitations (accepted, not solved)

- An email removed from a row's cell is detached **and stays in `synced_emails`** — it will not
  re-sync until the user resets the synced-email list. Document in README.
- Rule 3 ambiguity is permanent for id-less, email-less duplicates: once two same-company+role
  applications exist, a 1.0.0-style row can never tell them apart — those rows become CREATEs
  (safe direction: duplicates are visible, wrong-target updates are not).

## Implementation notes (as built)

- `buildImportPlan` (`client/src/utils/importCsv.ts`) replaces `reconcileApplications` and emits
  the full mutation plan; `db.applyImportPlan` (`server/services/db.ts`) applies it in one
  transaction behind `POST /api/applications/import` (`server/routes/applications.ts`), which
  re-sanitizes every piece with the same helpers as POST/PATCH.
- The pre-validation reject replaced the `.every()` in-file duplicate fix and its regression test.
- Preserved-id and adopted-id inserts re-check "is this id free" inside the transaction (never
  `INSERT OR IGNORE`, which would silently drop the row on collision).
- The sync/import mutual exclusion lives in `server/services/syncState.ts`; each side 409s while
  the other runs.
- `express.json` needed a raised body limit (10mb) — the plan ships a whole board in one request.
- A repeated message id rejects the file wherever it occurs — across rows ("two applications claim
  this email") or twice inside ONE Emails cell, which carries its own message naming the row. The
  in-cell case is not merely cosmetic: the two entries usually disagree on stage/date, so keeping
  either would be the import choosing a status on the user's behalf.
