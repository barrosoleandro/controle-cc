-- Import log: the rows of each file that were not written, and why.
--
-- An import skips rows it takes for ones already stored (same account, date, amount and
-- vendor), and the database itself drops a row whose fingerprint is already there. Until now
-- only the counts were kept, so a row skipped by mistake could only be found again with the
-- original file. Each entry: {date, account_ref, description, amount, currency, reason, matches}.
-- The audit on the Importar page reads it; the app works without it (nothing is logged then).

alter table public.imports add column if not exists skipped jsonb not null default '[]'::jsonb;
