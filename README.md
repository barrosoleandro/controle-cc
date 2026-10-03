# Finanças Pessoais

Personal finance control: BCP and CCF (EUR) + Itaú (BRL), secure, works on mobile (installable PWA).
The interface is in Portuguese; code and comments stay in English.

**Stack:** React + TypeScript (Vite) · Supabase (Postgres, Auth, RLS) · hosted on Vercel.

## What it does

| Area | Features |
|---|---|
| Import | Drop the BCP CSV, the BCP and CCF relevé PDFs, the Itaú extrato PDFs (app export or "Extrato Mensal") and the Itaú card bills, all at once. CCF letters without transactions are skipped. Files are parsed **in the browser**: the originals never leave your device. Duplicates are skipped automatically, even when the same operation appears in the CSV and in a PDF. |
| Balance rebuild | Opening balance is derived from the bank's own balances. Every balance printed on a statement is stored and reconciled (Settings → Accounts). |
| Categories | Your spreadsheet categories + merchant rules + bank-category mapping. Change a category once and the app offers to create a rule. |
| Dashboard | A quick look at the month: KPIs, income vs expenses, spending by category, budget vs actual, balance evolution, alerts, savings suggestions. **Customizable:** show/hide and reorder widgets; filter by month and account; EUR/BRL toggle. |
| Análises | One row of filters (period with presets, custom dates and ‹ › steps; comparison with the previous period or the same period a year earlier; spending or income; accounts, card purchases following the paying account; categories; merchant/description text; minimum amount) scoping six views: **overview** (KPIs with change, evolution by day/week/month against the comparison, composition by category, biggest movers, new merchants, by country), **trend** (3-month average, fitted line carried 3 months ahead, income vs expenses and result, year-to-date against the previous year, trend per category), **categories** and **merchants** (sortable tables with share, count, average charge, frequency, change and sparkline; click for a detail with month by month, merchants inside, every purchase over time), **dates** (weekday, day of month, category × month heat map, biggest charges) and the **rows** behind every number, exportable to CSV. |
| Subscriptions | Automatic detection of recurring charges; alerts for price increases, new subscriptions, upcoming charges and annual renewals. |
| Payslips | Import your *bulletins de paie* (PDF, parsed in the browser). Monthly detail of every line (earnings, contributions, employer cost, PAS), month-over-month changes, and a **contract check**: base salary, prime d'impatriation and car benefit must match the contract amounts (editable). One payslip per month — re-importing replaces, never duplicates. |
| Investments | Study screen for the investment **types** available in Brazil and France (Tesouro, CDB/LCI, ações, FIIs, ETFs; Livret A, PEA, assurance-vie, CTO, PER) with liquidity, risk and general tax notes. Emergency-reserve check, allocation per risk profile and a real-return projection, all from your own numbers. Editable assumptions, no specific security or broker is ever recommended. |
| AI enrichment | Uses your Claude plan, no API key. **Importar → Identificar com IA** downloads a JSON of the merchants the rules cannot place; ask Claude (Claude Code or claude.ai) to categorize it, then import its answer file. Claude picks a category **from your own list** and writes one line saying what the vendor sells. The file holds only the merchant key and statement snippets — never the statement, the balance or the account number. Nothing is applied until you accept it, and accepted merchants are remembered for the next imports. |
| Learning | Every category you set by hand becomes a merchant rule, so the next import repeats the choice. The Import tab also derives rules from your history and lets you set categories **before** the rows are written. |
| Simulation | Country scenarios (FR, PT incl. IFICI, LU, BR, custom): gross/year → net/month, rent, school, cost-of-living index, extra costs, savings projection (nominal and real), side-by-side comparison, savings proposals. The baseline is calculated from your real data. |

## Local model (Ollama), optional

Merchant identification and the payslip-comparison explanation can run on a local model, so
nothing leaves the machine. Turn it on in **Ajustes → IA local** (address + model). The setting
is **per device** (localStorage), like the appearance one: each computer keeps its own address
and model instead of syncing the wrong one across machines.

- Install Ollama and pull a model: `ollama pull qwen3.5:4b`.
- The deployed site runs on another origin, so Ollama has to accept it. Set `OLLAMA_ORIGINS` to
  `https://controle-cc.vercel.app` in Ollama's environment and restart the service. Safari blocks
  an HTTPS page from calling `http://localhost`; Chrome and Edge allow it, and running the app
  locally (`npm run dev`) works everywhere.
- **Where the model files live is an Ollama setting, not an app one.** It is the `OLLAMA_MODELS`
  environment variable, read by the daemon at startup — a web page cannot move a folder on disk,
  so it is not configurable from Ajustes. Point it at another drive only if you also move the
  existing files; the default is `%USERPROFILE%\.ollama\models`, and an empty new path makes
  already-pulled models look gone.
- `vercel.json` allows `localhost` and `127.0.0.1` in `connect-src`. Ollama on **another machine**
  needs that host added there too — CSP takes hosts, not IP ranges.
- The arithmetic always stays in code. The model only puts an already-computed diff into words, or
  proposes a category from the user's own list: it cannot change a number, and a category it
  invents is rejected by the same parser the Claude file exchange uses.
- Measured on qwen3.5:4b (4.7B, Q4_K_M): about 70 s for 4 merchants and 38 s for one payslip
  explanation. Budget minutes, not seconds. A local model is also less accurate than a hosted one,
  which is why suggestions below 60% confidence arrive unchecked.
- Reasoning models are called with thinking off: on a local machine it costs minutes and buys
  nothing on these two tasks.

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
4. On your phone, open the Vercel URL → Share/menu → **Add to Home Screen**.
5. First login: scan the QR code with an authenticator app. Then go to **Importar**, pick the whole statements folder at once ("Pasta inteira"), and click Import.

Local development: `npm install`, copy `.env.example` to `.env.local` and fill it in, then `npm run dev`.

## Maintenance

- `npm test`: unit tests (parsers, mapping, dedupe, subscriptions, tax model, simulation, rule learning, investment projections).
- `npm run rebuild -- "<folder with statements>"`: offline rebuild + reconciliation report (writes `out/`, which is git-ignored).
- The tax parameters are in `src/domain/tax.ts` (`TAX_PARAMS`). Update them every January.
- Adding a bank: add a parser in `src/parsers/`, register it in `src/parsers/index.ts`, and add tests.
- The Claude file exchange (export format, instructions, answer parsing) is in `src/domain/claudeExchange.ts`. An answer
  naming a category that is not in your list is read as "unsure", so Claude can never invent a category.

## Known limits (be aware)

- **Itaú "Extrato Mensal"**: the checking account and "Aplic Aut Mais" are read as one balance, as the bank's own totals do: the sweeps between them are left out, the yield counts as income.
- **Itaú credit card**: import each bill (fatura) as PDF or as Excel (.xlsx) to see the real spending; without it only the bill payment is visible (category "Cartão Itaú"). Future instalments ("próximas faturas") are not imported until their own bill.
- **Transfers to Wise/Revolut/Millennium** are treated as internal. Those accounts are not imported, so money that leaves through them is invisible.
- **The tax model is simplified** (for comparing scenarios, not payroll-grade). Validate a real offer with a local simulator or an advisor.
- The cost-of-living indexes are assumptions. Edit them in each scenario.
- **The Investments screen is not advice.** It lists categories of investment, never specific securities, and its expected
  returns are editable assumptions. Tax notes are the general case and change often; residency between France and Brazil
  changes the outcome. Confirm with a professional before acting.
- **AI suggestions are suggestions.** Statement descriptions are truncated and abbreviated, so a vendor can be misread.
  Rows under 60% confidence arrive unchecked on purpose; review before accepting.
