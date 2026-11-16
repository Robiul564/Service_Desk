# Passport Desk

Phone-first worker, agent, employer, payment, and office ledger for a Bangladesh → Malaysia recruitment office. The browser app is a static PWA; Supabase Postgres and Supabase Auth provide cloud storage and account access.

## What is included

- Passport MRZ scan using the phone camera or a selected/taken photo. TD3 check digits are validated; OCR substitutions are corrected and failed checks remain visible for review.
- Offline-first IndexedDB records and a per-account change queue. The app saves locally before syncing and displays pending changes or sync errors.
- Worker, agent pair, company, payment, money handover, and office-expense create/edit/soft-delete workflows; trash and restore; payment receipts; audit history; and one-tap version restore.
- Admin/staff/viewer authorization enforced by Postgres RLS. Admin account creation uses the `admin-users` Supabase Edge Function.
- Search/filter, pagination, CSV and Excel export, filtered print/PDF, worker dossier print/PDF, weekly backup reminder, and full JSON backup/restore.
- PWA shell caching, safe-area-aware mobile layout, and light/dark themes.

## Data model

`user_profiles` assigns each Auth user an `admin`, `staff`, or `viewer` role. `agents` holds one Malaysia/Bangladesh partner pair. `companies` stores employer vacancy and fee. `workers` references an agent and, when matched by company name, an employer; active passport numbers are unique. `payments` records the three defined stages and receipt references. `handovers` and `expenses` hold the office ledgers. Every editable table has server timestamps and `deleted_at`; every update is captured in append-only `history`.

The database has no client DELETE grant and rejects hard deletes. Restore is an update, so it is audited too. Conflicting offline updates use last-write-wins by `updated_at`; the overwritten server version remains in history. Cloud timestamps come from Postgres. A device with an incorrect clock can still affect which queued edit wins; keep device time automatic.

## One-time Supabase setup

1. Create a Supabase project at [supabase.com](https://supabase.com/). Choose a region near the office. Keep the database password in a password manager.
2. In the project, open **SQL Editor → New query**. Open this folder’s `schema.sql`, copy all of it into the query, and click **Run**. Confirm that the tables were created without errors.
3. Open **Authentication → Users → Add user**. Enter the owner’s email and a strong password; confirm the user if the screen offers that option.
4. Return to **SQL Editor → New query** and promote only that first owner account to admin. Replace the email below with the exact account email, then click **Run**:

   ```sql
   update public.user_profiles
   set role = 'admin', enabled = true
   where lower(email) = lower('owner@example.com');
   ```

   The result should report one updated row. Do not make public/anonymous users admins.
5. Disable public registration. In **Authentication → Sign In / Providers → Email** (wording may be **Authentication → Providers → Email**), turn off **Allow new users to sign up** and save. Users must be provisioned by an administrator.
6. (Optional, recommended for the in-app user form) Install the Supabase CLI, sign in, and link this project from this folder:

   ```powershell
   supabase login
   supabase link --project-ref YOUR_PROJECT_REF
   supabase functions deploy admin-users
   ```

   In **Project Settings → API**, copy the service-role key. Set it only as an Edge Function secret—never in `config.js` or any browser file:

   ```powershell
   supabase secrets set SUPABASE_SERVICE_ROLE_KEY="YOUR_SERVICE_ROLE_KEY"
   ```

   Confirm `admin-users` is deployed with JWT verification enabled (the default). The function verifies the caller’s enabled admin profile before creating an account.
7. Open **Project Settings → API**. Copy **Project URL** and the **anon/public** key. Edit `config.js` and replace only `PASTE_SUPABASE_URL` and `PASTE_SUPABASE_ANON_KEY`. The anon key is public by design; RLS is the security boundary. Do not use the service-role key here.
8. (Optional starter data) In **SQL Editor**, run `seed.sql` once, after `schema.sql`. It imports the supplied workbook data and prints imported/source counts. Do not rerun it on a live database; its inserts are intended for a fresh project.
9. In **Authentication → URL Configuration**, add the final HTTPS website address to **Site URL** and **Redirect URLs**. The app uses email/password sign-in, but the canonical site URL should still match deployment.

## Import reconciliation and dates

The supplied workbook data was mapped into `seed.sql`:

| Source | Imported |
|---|---:|
| Agent Master | 65 agent pairs |
| Company Master | 4 companies |
| Passenger Master | 53 workers |
| Agent-only roster candidates | 28 additional workers with generated worker IDs |
| Payment Tracker | 1 receipt (WRK-001, Advance, BDT 50,000; source date was blank) |
| Money Handover transaction rows | 0 |
| Office Expense transaction rows | 0 |

The seed finishes with SQL count queries so you can compare imported totals against those source totals. The Money Handover sheet’s BDT 50,000 summary balance is not a transaction; it corresponds to the candidate collection above and was not duplicated as a handover.

Twelve passport expiries are marked `review = true`. Their date fields are blank, and the imported candidate ISO value is retained in the worker notes; verify each against the original workbook and passport before entering a date. Other populated Excel serial dates were normalized to ISO dates in the seed. Never remove a review flag until the original document has been checked.

## Run and deploy

1. For local testing, use a local static server (not `file://`, which prevents ES modules and camera access). For example, with Python installed:

   ```powershell
   py -m http.server 8080
   ```

   Visit `http://localhost:8080`. Camera access on phones requires HTTPS; local HTTP is permitted by most browsers only on the same device.
2. **Do not deploy the project root.** `seed.sql` contains personal worker/passport information. Create a clean staging folder and copy only the public app shell:

   ```powershell
   New-Item -ItemType Directory -Force .\dist | Out-Null
   Copy-Item .\index.html, .\app.js, .\mrz.mjs, .\styles.css, .\config.js, .\sw.js, .\manifest.webmanifest, .\icon.svg .\dist\
   Get-ChildItem .\dist
   ```

   Verify that the listing contains only those eight files. Never copy `seed.sql`, `schema.sql`, the workbook, backups, README, test files, or Supabase function files to the public site. For later deployments, use a fresh, empty staging directory and repeat the allowlisted copy.
3. Deploy the contents of `dist` with a free static host:
   - **Cloudflare Pages:** create a Pages project with **Direct Upload**, choose a project name, and upload the `dist` folder.
   - **Netlify:** use the manual deploy/drag-and-drop screen and upload `dist`.
   - For a Git-based host, configure the published directory as `dist` (not the repository root).
4. Open the deployed HTTPS URL on a phone, sign in, add it to the browser’s home screen, then scan a test passport. On Android Chrome use **⋮ → Install app** / **Add to Home screen**. On iPhone Safari use **Share → Add to Home Screen**.
5. Test a new worker, a payment receipt, trash/restore, a viewer account, offline save and reconnect, and one export before using the app for live records.

### Render + Supabase Free

The Render Blueprint in `render.yaml` creates a free static site. Its build script publishes only the eight public app files into `dist`, generates `config.js` from Render environment variables, and versions the service-worker cache for each build so deployed settings refresh. It fails if either value is missing and rejects known Supabase secret/service-role keys.

1. Create a Supabase Free project and complete the schema, owner-admin, and signup-disable steps above. Supabase Free currently includes 500 MB and can pause projects after one week of inactivity; it has no uptime SLA. It is suitable for a cost-free trial, not guaranteed continuous availability. Keep verified backups.
2. Before pushing this folder, create a **private** GitHub repository. `.gitignore` excludes `seed.sql`, spreadsheets, local backups, `.env` files, and `dist`. Verify those personal-data files are not tracked or committed; `.gitignore` cannot remove files already committed.
3. In Render, choose **New → Blueprint**, connect the private repository, and select `render.yaml`. When prompted, set `SUPABASE_URL` and `SUPABASE_ANON_KEY` from Supabase **Project Settings → API**. Use only the anon/publishable key; never enter a service-role key in Render or any browser configuration. Start the deploy.
4. After the first deploy, copy its HTTPS `onrender.com` URL into Supabase **Authentication → URL Configuration** as the Site URL and an allowed Redirect URL. Test sign-in and the core workflows before using live records.
5. The optional `admin-users` function remains a Supabase Edge Function. Deploy it with the Supabase CLI and set `SUPABASE_SERVICE_ROLE_KEY` only as a Supabase function secret, as described above.

Render deploys from a connected Git repository; this project folder currently has no Git repository. The Render account, Supabase project, private repository, and provider values must be created/entered in your own accounts. Do not upload the supplied passport data to a public repository or site.

## Adding and disabling users

After deploying the Edge Function, an admin can enter a user email, temporary password (8+ characters), and role in **More → Accounts → Create account**. Deliver the temporary password privately and ask the user to change it after their first sign-in. Admins can disable or re-enable existing accounts without deleting their history.

If the function is not deployed, create a user in **Supabase → Authentication → Users → Add user**, then assign a role in SQL Editor. For example:

```sql
update public.user_profiles
set role = 'staff', enabled = true
where lower(email) = lower('staff@example.com');
```

`staff` can read and write business records; `viewer` can read; only `admin` can manage profiles. Disabling a profile blocks RLS access even if the user still has a valid login token.

## Backups and recovery

- Use **More → Download full backup** weekly and before major imports or account changes. Store the JSON in an access-controlled office drive; it includes passport data and audit history. The app reminds you after seven days.
- Use **More → Spreadsheet backup** to download an `.xlsx` snapshot with separate sheets for each record table, trash, user profiles visible to your account, and audit history. Upload it manually to a private Google Drive account and open it with Google Sheets. This is a one-way snapshot, not automatic sync or an app-restorable backup; use the JSON file for restore. Never enable public/link sharing for these files.
- To restore, sign in to the correct account, open **More → Restore backup**, and choose the JSON. Existing rows are not replaced by an older backup timestamp; new/missing rows are queued for sync. Audit history is immutable and retained in the backup, but cannot be replayed into the server’s append-only history table through the client.
- Verify Supabase **Database → Backups** availability and retention for your selected plan. The app does not set up a scheduled third-party export; retain weekly JSON backups regardless.
- Keep a second copy of the seed workbook and a record of the SQL reconciliation counts outside the public website.

## Test and maintenance

With Node.js 20+ installed, run the focused MRZ unit tests from this folder:

```powershell
node --test tests\mrz.test.mjs
```

For browser-module syntax validation:

```powershell
Get-Content .\app.js -Raw | node --input-type=module --check
node --check .\mrz.mjs
node --check .\sw.js
```

Review **More → Cloud sync** when the badge reports pending changes or an error. Reconnect and use **Sync now**; do not clear browser data until the pending count is zero or a verified backup exists.

## Manual verification and known limitations

- Manually verify the twelve passport expiry entries marked for review and any other questionable source data before relying on alerts.
- Camera scanning, continuous focus, and the torch depend on the phone and browser. Camera permission requires HTTPS. OCR and first-time language/core downloads require a network connection; a cached PWA shell does not guarantee every Tesseract worker/language asset is available offline.
- Excel export lazily downloads pinned SheetJS from jsDelivr; PDF export uses the browser print dialog’s **Save as PDF**. These export-library/print actions may need network access or a browser that supports printing.
- Offline edits are stored in browser IndexedDB, which is not encrypted by this app. Use a secured, locked phone and sign out on shared devices. The app partitions offline data by account.
- Last-write-wins uses device edit timestamps against server timestamps; clock skew can affect conflict outcomes. Previous server versions remain in audit history. Check history when two staff edit the same record offline.
- New users need an internet connection and a working Supabase project to sign in. The app does not implement email/password self-registration, biometric authentication, file/photo retention, or automatic scheduled cloud backups.
