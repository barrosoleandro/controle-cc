/**
 * Offline rebuild + reconciliation of the statement folder.
 * Usage: npx tsx scripts/rebuild.mts <folder> [outDir]
 * Parses every CSV/PDF, de-duplicates, categorizes, and checks the rebuilt running balance
 * against every balance printed by the bank. Writes a CSV of transactions and a Markdown report.
 * Nothing is sent anywhere — this is the same code the web app runs in the browser.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { parseStatement } from '../src/parsers/index.ts'
import { withFingerprints } from '../src/domain/fingerprint.ts'
import { categorize } from '../src/domain/categorize.ts'
import { DEFAULT_BANK_MAP, DEFAULT_RULES } from '../src/domain/defaults.ts'
import type { Checkpoint, ParsedTransaction } from '../src/domain/types.ts'

const [folder, outDir = 'out'] = process.argv.slice(2)
const load = (d: Uint8Array) => pdfjs.getDocument({ data: d, useSystemFonts: true, verbosity: 0 }).promise as never

const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]))

type Tx = ParsedTransaction & { fingerprint: string; source: string; file: string }
const txs = new Map<string, Tx>()
const cps = new Map<string, Checkpoint & { source: string }>()
const log: string[] = []

// CSV first: it carries the bank's categories, so it wins over the same operation from a PDF.
const files = walk(folder).filter((f) => /\.(csv|pdf)$/i.test(f)).sort((a, b) => Number(/\.pdf$/i.test(a)) - Number(/\.pdf$/i.test(b)))
for (const file of files) {
  try {
    const res = await parseStatement(file, new Uint8Array(readFileSync(file)), load)
    let added = 0
    for (const t of withFingerprints(res.transactions, (r) => r)) {
      if (!txs.has(t.fingerprint)) { txs.set(t.fingerprint, { ...t, source: res.source, file }); added++ }
    }
    for (const c of res.checkpoints) cps.set(`${c.accountRef}|${c.date}`, { ...c, source: res.source })
    log.push(`| ${file.split('/').slice(-2).join('/')} | ${res.source} | ${res.transactions.length} | ${added} | ${res.checkpoints.length} | ${res.warnings.join('; ')} |`)
  } catch (e) {
    log.push(`| ${file.split('/').slice(-2).join('/')} | ERROR | | | | ${(e as Error).message} |`)
  }
}

const all = [...txs.values()].sort((a, b) => a.accountRef.localeCompare(b.accountRef) || a.bookingDate.localeCompare(b.bookingDate))
const byAcc = Map.groupBy(all, (t) => t.accountRef)
const report: string[] = ['# Rebuild & reconciliation report', '', '## Files', '', '| File | Parser | Rows | New | Balances | Warnings |', '|---|---|---|---|---|---|', ...log, '']

for (const [acc, list] of byAcc) {
  const accCps = [...cps.values()].filter((c) => c.accountRef === acc).sort((a, b) => a.date.localeCompare(b.date))
  // Opening balance: derive from the earliest bank balance on/after the first transaction day.
  const first = accCps.find((c) => c.date >= list[0].bookingDate) ?? accCps[0]
  const sumTo = (d: string) => list.filter((t) => t.bookingDate <= d).reduce((s, t) => s + t.amount, 0)
  const opening = first ? Math.round((first.balance - sumTo(first.date)) * 100) / 100 : 0
  report.push(`## Account ${acc}`, '', `Transactions: ${list.length} (${list[0].bookingDate} → ${list.at(-1)!.bookingDate}). Opening balance derived: **${opening.toFixed(2)}** (from bank balance on ${first?.date}).`, '')
  report.push('| Date | Bank balance | Rebuilt | Diff |', '|---|---|---|---|')
  let bad = 0
  for (const c of accCps) {
    const rebuilt = Math.round((opening + sumTo(c.date)) * 100) / 100
    const diff = Math.round((rebuilt - c.balance) * 100) / 100
    if (Math.abs(diff) > 0.01) bad++
    // Keep the report short for accounts with daily balances (Itaú): print mismatches + month ends.
    const monthEnd = !accCps.some((o) => o.date > c.date && o.date.slice(0, 7) === c.date.slice(0, 7))
    if (Math.abs(diff) > 0.01 || monthEnd) report.push(`| ${c.date} | ${c.balance.toFixed(2)} | ${rebuilt.toFixed(2)} | ${diff === 0 ? '✔' : diff.toFixed(2)} |`)
  }
  report.push('', `**${accCps.length - bad}/${accCps.length} bank balances matched.**`, '')
}

// Categorization coverage
const cat = all.map((t) => ({ ...t, category: categorize(t, DEFAULT_RULES, DEFAULT_BANK_MAP, t.source.startsWith('itau') ? 'ITAU' : 'BCP') }))
const cov = Map.groupBy(cat, (t) => t.category)
report.push('## Categorization', '', '| Category | Count | Total |', '|---|---|---|')
for (const [k, v] of [...cov].sort((a, b) => b[1].length - a[1].length))
  report.push(`| ${k} | ${v.length} | ${v.reduce((s, t) => s + t.amount, 0).toFixed(2)} |`)

mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'reconciliation.md'), report.join('\n'))
const esc = (s: string) => `"${s.replace(/"/g, '""')}"`
writeFileSync(join(outDir, 'transactions.csv'), ['account_ref;booking_date;description;amount;currency;bank_category;bank_subcategory;category;source',
  ...cat.map((t) => [t.accountRef, t.bookingDate, esc(t.description), t.amount.toFixed(2), t.currency, esc(t.bankCategory ?? ''), esc(t.bankSubcategory ?? ''), t.category, t.source].join(';'))].join('\n'))
console.log(report.join('\n'))
