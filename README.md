# Finanças Pessoais

Personal finance control: BCP (EUR) + Itaú (BRL), secure, works on mobile (installable PWA).
The interface is in Portuguese; code and comments stay in English.

**Stack:** React + TypeScript (Vite) · Supabase (Postgres, Auth, RLS) · hosted on Vercel.

## What it does

| Area | Features |
|---|---|
| Import | Drop the BCP CSV, the BCP relevé PDFs and the Itaú extrato PDFs, all at once. Files are parsed **in the browser**: the originals never leave your device. Duplicates are skipped automatically, even when the same operation appears in the CSV and in a PDF. |
| Balance rebuild | Opening balance is derived from the bank's own balances. Every balance printed on a statement is stored and reconciled (Settings → Accounts). |
| Categories | Your spreadsheet categories + merchant rules + bank-category mapping. Change a category once and the app offers to create a rule. |
| Dashboard | KPIs, income vs expenses, spending by category, budget vs actual, top-5 trend, balance evolution, top merchants, alerts, savings suggestions. **Customizable:** show/hide and reorder widgets; filter by month and account; EUR/BRL toggle. |
| Subscriptions | Automatic detection of recurring charges; alerts for price increases, new subscriptions, upcoming charges and annual renewals. |
| Payslips | Import your *bulletins de paie* (PDF, parsed in the browser). Monthly detail of every line (earnings, contributions, employer cost, PAS), month-over-month changes, and a **contract check**: base salary, prime d'impatriation and car benefit must match the contract amounts (editable). One payslip per month — re-importing replaces, never duplicates. |
| Investments | Study screen for the investment **types** available in Brazil and France (Tesouro, CDB/LCI, ações, FIIs, ETFs; Livret A, PEA, assurance-vie, CTO, PER) with liquidity, risk and general tax notes. Emergency-reserve check, allocation per risk profile and a real-return projection, all from your own numbers. Editable assumptions, no specific security or broker is ever recommended. |
| AI enrichment | During an import, merchants the rules cannot place are sent to Claude through a Supabase Edge Function, which suggests a category **from your own list** and writes one line saying what the vendor sells. Only the merchant key and statement snippets leave the browser — never the file, the balance or the account number. Nothing is applied until you accept it. |
| Learning | Every category you set by hand becomes a merchant rule, so the next import repeats the choice. The Import tab also derives rules from your history and lets you set categories **before** the rows are written. |
| Simulation | Country scenarios (FR, PT incl. IFICI, LU, BR, custom): gross/year → net/month, rent, school, cost-of-living index, extra costs, savings projection (nominal and real), side-by-side comparison, savings proposals. The baseline is calculated from your real data. |

## Security model

- **A dedicated Supabase project.** Don't share one with other apps.
- **Row Level Security on every table:** a row is visible only to its owner, and **only with an MFA-verified session (aal2)**. A stolen password alone returns zero rows (tested).
- **TOTP 2FA is mandatory**: the app enrolls it on first login.
- **Only the public anon key is used in the app**; the service_role key is never used.
- Public sign-ups are disabled. Your user is created by hand in the dashboard.
- **Screen locks after 15 minutes** of inactivity and **signs out after 60**. The lock keeps the session, so coming back
  costs only the authenticator code — no password, no e-mail. Strict security headers (CSP, HSTS, no framing) are in `vercel.json`.
- **Bank files are not uploaded.** Only the extracted rows are stored.

## Setup (≈20 minutes, once)

1. **Supabase**: create a new project (e.g. `controle-cc`, region Frankfurt/Paris).
   - SQL Editor → paste and run `supabase/migrations/001_schema.sql`, then `002_payslips.sql`, then `003_merchant_profiles.sql`, then `004_cards.sql` (credit cards linked to accounts).
   - Authentication → Sign In / Providers → **disable "Allow new users to sign up"**.
   - Authentication → Multi-Factor → make sure **TOTP is enabled**.
   - For the e-mail code login: Authentication → Emails → the "Magic Link" template must contain `{{ .Token }}`,
     otherwise Supabase sends a link instead of the 6-digit code the app asks for.
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
4. **AI enrichment (optional)**: the Anthropic key stays server-side, never in the browser.
   ```
   npx supabase link --project-ref <your-project-ref>
   npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
   npx supabase functions deploy enrich-transactions
   ```
   Without this step everything else works; only the "Identificar com IA" button fails, saying the function is not deployed.
   The function refuses any request whose JWT is not `aal2`, mirroring the RLS policies.
5. On your phone, open the Vercel URL → Share/menu → **Add to Home Screen**.
6. First login: scan the QR code with an authenticator app. Then go to **Importar**, pick the whole statements folder at once ("Pasta inteira"), and click Import.

Local development: `npm install`, copy `.env.example` to `.env.local` and fill it in, then `npm run dev`.

## Maintenance

- `npm test`: unit tests (parsers, mapping, dedupe, subscriptions, tax model, simulation, rule learning, investment projections).
- `npm run rebuild -- "<folder with statements>"`: offline rebuild + reconciliation report (writes `out/`, which is git-ignored).
- The tax parameters are in `src/domain/tax.ts` (`TAX_PARAMS`). Update them every January.
- Adding a bank: add a parser in `src/parsers/`, register it in `src/parsers/index.ts`, and add tests.
- The Edge Function lives in `supabase/functions/enrich-transactions/`. It runs on Deno and is **not** covered by
  `npm run build` or `npm test`; after changing it, redeploy and exercise the button once.
- The AI model is pinned in that function (`MODEL`). It answers through a strict tool schema whose category list is an
  enum of your own categories, so it can never invent a category name.

## Known limits (be aware)

- **Itaú credit card**: only the bill total is visible (category "Cartão Itaú"). Import the card statement to see the real spending; a parser is not built yet.
- **Transfers to Wise/Revolut/Millennium** are treated as internal. Those accounts are not imported, so money that leaves through them is invisible.
- **The tax model is simplified** (for comparing scenarios, not payroll-grade). Validate a real offer with a local simulator or an advisor.
- The cost-of-living indexes are assumptions. Edit them in each scenario.
- **The Investments screen is not advice.** It lists categories of investment, never specific securities, and its expected
  returns are editable assumptions. Tax notes are the general case and change often; residency between France and Brazil
  changes the outcome. Confirm with a professional before acting.
- **AI suggestions are suggestions.** Statement descriptions are truncated and abbreviated, so a vendor can be misread.
  Rows under 60% confidence arrive unchecked on purpose; review before accepting.
