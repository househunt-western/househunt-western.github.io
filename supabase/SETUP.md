# Setting up the shared database (Supabase)

Supabase is a free hosted database. It holds everyone's accounts (email + password) and each friend group's votes, notes, statuses and scorecards. Anyone can sign up on the website, start a group and share its invite link; you never have to add people by hand. Setup takes about 30 minutes and needs no coding.

---

## 1. Make a Supabase account

1. Go to **supabase.com** and click **Start your project**.
2. Sign up with **Continue with GitHub** (easiest if you already have GitHub; you'll need it for the website anyway) or with your email.
3. The **Free** plan is all we need. Don't add a credit card.

## 2. Create a project

1. Click **New project**.
2. Fill in:
   - **Name:** `london-housing`
   - **Database password:** click **Generate a password** and save it in your password manager. You won't need it day to day.
   - **Region:** **Canada (Central)**, since it's closest to London, Ontario.
3. Click **Create new project** and wait 1–2 minutes while it sets up.

## 3. Create the tables

1. In the left sidebar, open **SQL Editor**.
2. Click **+ New query**.
3. Open `supabase/schema.sql` from this project, copy **all** of it, and paste it into the editor.
4. Click **Run** (bottom right). You should see **Success. No rows returned**.

If you ever run it again, nothing is lost. It only adds what's missing.

## 4. Accounts and the email that sends reset codes

People sign in with email + password. If they forget it, Supabase emails a 6-digit code. Supabase's own email service only reaches your own address, so connect a Gmail made just for this.

**a. Make the Gmail and an App Password**
1. Make a new Gmail account, e.g. `househunt.london@gmail.com`.
2. In that account: **Manage your Google Account** → **Security** → turn on **2-Step Verification**.
3. Search the account settings for **App passwords**, create one called `Supabase`, and copy the 16-letter password. Google shows it once.

**b. Tell Supabase to send from it**
1. Supabase → **Authentication** → **Emails** → **SMTP Settings** → turn on **Enable custom SMTP**.
2. Fill in:
   - **Sender email:** the new Gmail address. **Sender name:** `House Hunt`
   - **Host:** `smtp.gmail.com`, **Port:** `465`
   - **Username:** the new Gmail address. **Password:** the App Password
3. **Save**.

**c. Put the code in the reset email**
1. **Authentication** → **Emails** → **Templates** → **Reset Password**.
2. Subject: `Your House Hunt code`. Body:
   ```html
   <p>Your House Hunt code is <strong>{{ .Token }}</strong></p>
   <p>Type it into the app to choose a new password. It works for one hour.</p>
   ```
3. **Save**.

**d. Sign-in settings**
1. **Authentication** → **Sign In / Providers** → **Email**:
   - **Confirm email:** off, so signing up is instant.
   - **Minimum password length:** `8`
   - **Email OTP length:** `6`
2. **Authentication** → **URL Configuration** → **Site URL:** your website, e.g. `https://YOUR-GITHUB-USERNAME.github.io/london-housing/`

## 5. Copy the two values the page needs

1. Left sidebar: **Project Settings** (gear icon), then **API Keys**. On some projects this is under **Data API**.
2. Copy:
   - **Project URL**, which looks like `https://abcdefgh.supabase.co`
   - The **public** key: either **Publishable key** (starts with `sb_publishable_`) or, on the legacy tab, **anon public** (a long `eyJ...` string). Either one works.
3. Open `site/js/config.js` and replace `supabase: null` with:

   ```js
   supabase: { url: "https://abcdefgh.supabase.co", anonKey: "PASTE_THE_PUBLIC_KEY" },
   ```

> **Never** put the **secret** / **service_role** key in the page or anywhere in this repo. That key skips every lock. It only goes into GitHub Secrets later (step 8).

## 6. Check it works (optional, 1 minute)

In Terminal, with your values swapped in:

```bash
curl -s "https://abcdefgh.supabase.co/rest/v1/rpc/group_preview" -H "apikey: PASTE_THE_PUBLIC_KEY" -H "Content-Type: application/json" -d '{"p_invite":"no-such-invite-123"}'
```

You should see `null`: the database answers, and there's no group with that invite.

## 7. Start your group

Open the website, tap **Create account**, then **Start a group**. The Group tab has your invite link, with a **Share** button for Snapchat, iMessage or Instagram. Friends who open it sign up and land in your group. Groups hold up to 5 people.

## 8. Give the daily GitHub job its keys (as soon as your GitHub repo exists)

The daily scrape job pings Supabase each morning so the free project never pauses. It also uses this to send phone alerts (`docs/github-setup.md`, 6d). It needs two values, stored as GitHub **secrets** (hidden, never shown in the code):
1. Repo on GitHub → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.
2. Add `SUPABASE_URL` (the Project URL from step 5).
3. Add `SUPABASE_SERVICE_KEY`: in Supabase, **Project Settings** → **API Keys**, the **secret** key (`sb_secret_...`) or, on the legacy tab, **service_role**. Click reveal, then copy.

If you haven't made the GitHub repo yet, skip this for now. `docs/github-setup.md` brings you back here.

---

## Good to know

- **Leaving:** anyone can leave a group from the Group tab. Their votes go with them. The last person out deletes the group.
- **Free projects pause after about a week with no activity.** Once step 8 is done, the daily job's "Keep Supabase awake" step prevents that. If it does pause, open the project on supabase.com and click **Restore**.
- **"RLS enabled, no policies" warnings** in Supabase's Security Advisor are expected. That's on purpose: the page can only use the locked functions, never the tables.

## Moving from the old one-group version

Databases set up before accounts had one shared group code and names typed in with `setup_group`. To move one over without losing votes, run these in the SQL Editor, in order:
1. `migrate-to-accounts.sql` (moves the old tables out of the way)
2. `schema.sql`
3. `select adopt_old_group('<the old group code>', '<a name for the group>');`

The old group becomes a normal group, and its invite is the old code, so the old link keeps working. Each friend signs in, taps their name once, and gets their votes back.

## Tests

`schema.sql` is tested on a real Postgres engine running on your laptop (PGlite). The tests act as the web page and confirm:
- the page can't read tables directly, and signed-out visitors can only preview an invite
- people in one group can't see or change another group's houses
- joining, starting and leaving groups follow the rules (5 per group, names unique, 3 groups each)
- votes, notes, statuses, budgets, scorecards and push subscriptions follow the same rules as the page
- the daily job's secret key can only do what phone alerts need: no invites, accounts or notes
- moving an old one-group database keeps every vote

```bash
cd supabase
```
```bash
npm install
```
```bash
npm test
```
