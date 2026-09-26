# Controle CC

Personal finance control: BCP (EUR) + Itaú (BRL), secure, works on mobile (installable PWA).

**Stack:** React + TypeScript (Vite) · Supabase (Postgres, Auth, RLS) · hosted on Vercel.

## What it does

| Area | Features |
|---|---|
| Import | Drop the BCP CSV, the BCP relevé PDFs and the Itaú extrato PDFs, all at once. Files are parsed **in the browser**: the originals never leave your device. Duplicates are skipped automatically, even when the same operation appears in the CSV and in a PDF. |
| Balance rebuild | Opening balance is derived from the bank's own balances. Every balance printed on a statement is stored and reconciled (Settings → Accounts). |
| Categories | Your spreadsheet categories + merchant rules + bank-category mapping. Change a category once and the app offers to create a rule. |
| Dashboard | KPIs, income vs expenses, spending by category, budget vs actual, top-5 trend, balance evolution, top merchants, alerts, savings suggestions. **Customizable:** show/hide and reorder widgets; filter by month and account; EUR/BRL toggle. |
| Subscriptions | Automatic detection of recurring charges; alerts for price increases, new subscriptions, upcoming charges and annual renewals. |
| Simulation | Country scenarios (FR, PT incl. IFICI, LU, BR, custom): gross/year → net/month, rent, school, cost-of-living index, extra costs, savings projection (nominal and real), side-by-side comparison, savings proposals. The baseline is calculated from your real data. |

## Security model

- **A dedicated Supabase project.** Don't share one with other apps.
- **Row Level Security on every table:** a row is visible only to its owner, and **only with an MFA-verified session (aal2)**. A stolen password alone returns zero rows (tested).
- **TOTP 2FA is mandatory**: the app enrolls it on first login.
- **Only the public anon key is used in the app**; the service_role key is never used.
- Public sign-ups are disabled. Your user is created by hand in the dashboard.
- **Auto sign-out after 15 minutes** of inactivity. Strict security headers (CSP, HSTS, no framing) are set in `vercel.json`.
- **Bank files are not uploaded.** Only the extracted rows are stored.

## Setup (≈20 minutes, once)

1. **Supabase**: create a new project (e.g. `controle-cc`, region Frankfurt/Paris).
   - SQL Editor → paste and run `supabase/migrations/001_schema.sql`.
   - Authentication → Sign In / Providers → **disable "Allow new users to sign up"**.
   - Authentication → Multi-Factor → make sure **TOTP is enabled**.
   - Authentication → Users → **Add user** (your email + a strong unique password, "auto confirm").
   - Project Settings → API: copy the **Project URL** and the **anon public** key.
2. **GitHub**: create a **private** repo `controle-cc` and push this folder:
   ```
   cd %USERPROFILE%\OneDrive\Documentos\ControleCC\controle-cc
   git init && git add . && git commit -m "Controle CC v1"
   git branch -M main
   git remote add origin https://github.com/<you>/controle-cc.git
   git push -u origin main
   ```
3. **Vercel**: New Project → import the repo → Environment Variables:
   `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` → Deploy.
4. On your phone, open the Vercel URL → Share/menu → **Add to Home Screen**.
5. First login: scan the QR code with an authenticator app. Then go to **Import**, select every file from the `BCP` and `Itaú` folders, and click Import.

Local development: `npm install`, copy `.env.example` to `.env.local` and fill it in, then `npm run dev`.

## Maintenance

- `npm test`: unit tests (parsers, mapping, dedupe, subscriptions, tax model, simulation).
- `npm run rebuild -- "<folder with statements>"`: offline rebuild + reconciliation report (writes `out/`, which is git-ignored).
- The tax parameters are in `src/domain/tax.ts` (`TAX_PARAMS`). Update them every January.
- Adding a bank: add a parser in `src/parsers/`, register it in `src/parsers/index.ts`, and add tests.

## Known limits (be aware)

- **Itaú credit card**: only the bill total is visible (category "Cartão Itaú"). Import the card statement to see the real spending; a parser is not built yet.
- **Transfers to Wise/Revolut/Millennium** are treated as internal. Those accounts are not imported, so money that leaves through them is invisible.
- **The tax model is simplified** (for comparing scenarios, not payroll-grade). Validate a real offer with a local simulator or an advisor.
- The cost-of-living indexes are assumptions. Edit them in each scenario.
