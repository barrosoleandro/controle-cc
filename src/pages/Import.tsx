import { useEffect, useRef, useState } from 'react'
import type { Ctx } from '../App'
import { addRule, deriveOpening, ensureAccounts, executeImport, importedHashes, linkCardPayments, loadAll, planImport, sha256, updateAccount, type ImportPlan } from '../lib/data'
import { saveMerchantProfiles } from '../lib/ai'
import { parseStatement } from '../parsers'
import { LearnedRules } from '../components/LearnedRules'
import { AiSuggestions } from '../components/AiSuggestions'
import { ImportCategories } from '../components/ImportCategories'

const SUPPORTED = /\.(csv|pdf|xlsx)$/i

/** Category picked for a merchant before importing (by hand or pre-filled by the AI). */
export interface Choice { categoryId: string; description?: string; confidence?: number; source: 'ai' | 'manual' }

/**
 * Files are parsed in the browser; only the extracted rows go to the database.
 * The original PDFs/CSVs never leave the device.
 */
export function ImportPage({ ctx }: { ctx: Ctx }) {
  const [plans, setPlans] = useState<ImportPlan[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [skipped, setSkipped] = useState<{ ignored: number; duplicateFiles: number }>({ ignored: 0, duplicateFiles: 0 })
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [choices, setChoices] = useState<Record<string, Choice>>({})
  const dirRef = useRef<HTMLInputElement>(null)

  // webkitdirectory is not in React's prop types; set it on the element itself.
  useEffect(() => {
    dirRef.current?.setAttribute('webkitdirectory', '')
    dirRef.current?.setAttribute('directory', '')
  }, [])

  async function onFiles(files: FileList | null) {
    if (!files?.length) return
    setBusy(true); setDone(null); setErrors([]); setPlans([]); setChoices({})
    const ps: ImportPlan[] = [], errs: string[] = []
    let ignored = 0, duplicateFiles = 0
    // A folder brings everything in it, including files that are not statements.
    const candidates = [...files].filter((f) => {
      if (SUPPORTED.test(f.name)) return true
      ignored++
      return false
    })
    // Three layers keep rows from doubling up:
    //  1. this set — byte-identical files inside the same selection;
    //  2. importedHashes() — files already imported in a previous session;
    //  3. the transaction fingerprint + unique(user_id, fingerprint) in the database,
    //     which also catches the same operation arriving via both the CSV and a PDF.
    const seen = await importedHashes()
    // CSVs first: they carry the bank's own categories.
    const ordered = candidates.sort((a, b) => Number(/\.pdf$/i.test(a.name)) - Number(/\.pdf$/i.test(b.name)))
    let i = 0
    for (const f of ordered) {
      setProgress(`Lendo ${++i} de ${ordered.length}: ${f.name}`)
      try {
        const bytes = new Uint8Array(await f.arrayBuffer())
        const hash = await sha256(bytes)
        if (seen.has(hash)) { duplicateFiles++; continue }
        seen.add(hash)
        const { loadPdf } = await import('../lib/pdf') // pdf.js is loaded only when importing
        const res = await parseStatement(f.name, bytes, loadPdf)
        ps.push(planImport(f.name, hash, res, ctx.data))
      } catch (e) { errs.push(`${f.name}: ${(e as Error).message}`) }
    }
    setPlans(ps); setErrors(errs); setSkipped({ ignored, duplicateFiles })
    setProgress(null); setBusy(false)
  }

  async function run() {
    setBusy(true)
    try {
      // Create accounts for unknown account numbers first (cards linked to their paying account).
      await ensureAccounts(plans, await loadAll()) // fresh: a failed earlier run may have created some
      // Categories chosen in the review (AI or by hand) become rules, so the rows are
      // born categorized and the next import already knows these merchants.
      const chosen = Object.entries(choices).filter(([m, c]) => c.categoryId && !ctx.data.rules.some((r) => r.pattern.toUpperCase() === m.toUpperCase()))
      let priority = Math.min(1000, ...ctx.data.rules.map((r) => r.priority)) - 1
      for (const [merchant, c] of chosen) { await addRule(merchant, c.categoryId, null, priority); priority-- }
      if (chosen.length) {
        try {
          await saveMerchantProfiles(chosen.map(([merchant, c]) => ({
            merchant, description: c.description ?? '', suggested_category_id: c.categoryId, confidence: c.confidence ?? null, source: c.source,
          })), true)
        } catch { /* migration 003 not run: the rules alone are enough */ }
      }
      let data = await loadAll()
      let total = 0
      // Re-plan against freshly loaded data between files, so dedupe sees the rows
      // the previous file just inserted.
      let i = 0
      for (const p of plans) {
        setProgress(`Importando ${++i} de ${plans.length}: ${p.fileName}`)
        total += await executeImport(planImport(p.fileName, p.sha256, p.result, data), data)
        data = await loadAll()
      }
      // Rebuild opening balances from the bank's own balances.
      for (const a of data.accounts) {
        const o = deriveOpening(a, data.transactions, data.checkpoints)
        if (o && (o.opening_balance !== a.opening_balance || o.opening_date !== a.opening_date)) await updateAccount(a.id, o)
      }
      // Card bills now in the app: their payments in the paying account become transfers.
      const linked = await linkCardPayments(await loadAll())
      setDone(`${total} lançamentos novos importados de ${plans.length} arquivos` +
        (chosen.length ? ` · ${chosen.length} regras criadas` : '') +
        (linked ? ` · ${linked} pagamentos de fatura marcados como transferência` : '') +
        '. Saldos iniciais recalculados — confira a conciliação em Ajustes → Contas.')
      setPlans([]); setChoices({})
      await ctx.reload()
    } catch (e) { setErrors([(e as Error).message]) } finally { setProgress(null); setBusy(false) }
  }

  const totalNew = plans.reduce((s, p) => s + p.newRows, 0)
  const totalDup = plans.reduce((s, p) => s + p.dupRows, 0)

  return (
    <div className="grid">
      <div className="card" style={{ gridColumn: '1/-1' }}>
        <h3>Importar arquivos do banco</h3>
        <p className="muted">
          Aceita o CSV do Banque BCP, o relevé mensal do BCP em PDF, o extrato de conta do Itaú em PDF,
          a fatura do cartão Itaú em PDF ou Excel (.xlsx) e o extrato combinado do Millennium bcp em PDF.
          Pode selecionar tudo de uma vez: linhas repetidas são descartadas sozinhas.
        </p>
        <div className="row">
          <label className="inline">Arquivos
            <input type="file" multiple accept=".csv,.pdf,.xlsx" onChange={(e) => onFiles(e.target.files)} disabled={busy} />
          </label>
          <label className="inline">Pasta inteira
            <input ref={dirRef} type="file" multiple onChange={(e) => onFiles(e.target.files)} disabled={busy} />
          </label>
        </div>
        <p className="muted" style={{ fontSize: 12 }}>
          A opção de pasta varre todas as subpastas e ignora o que não for CSV, PDF ou XLSX. No iPhone/iPad o Safari não permite
          selecionar pastas — use a seleção de arquivos, ou faça a importação em massa no computador.
        </p>
        {progress && <p className="muted">{progress}</p>}
        {busy && !progress && <p className="muted">Processando…</p>}

        {(skipped.ignored > 0 || skipped.duplicateFiles > 0) && !busy && (
          <p className="muted">
            {skipped.duplicateFiles > 0 && `${skipped.duplicateFiles} arquivo(s) já importados anteriormente foram pulados. `}
            {skipped.ignored > 0 && `${skipped.ignored} arquivo(s) fora do formato CSV/PDF/XLSX foram ignorados.`}
          </p>
        )}
        {errors.length > 0 && <details>
          <summary className="err">{errors.length} arquivo(s) não foram lidos</summary>
          {errors.slice(0, 30).map((e) => <p key={e} className="err" style={{ fontSize: 13 }}>{e}</p>)}
          {errors.length > 30 && <p className="muted">e mais {errors.length - 30}…</p>}
        </details>}

        {plans.length > 0 && <>
          <p><strong>{plans.length} arquivos prontos</strong> · {totalNew} linhas novas · {totalDup} repetidas serão descartadas</p>
          <div className="scroll"><table style={{ marginTop: 12 }}>
            <thead><tr><th>Arquivo</th><th>Tipo</th><th className="num">Novas</th><th className="num">Repetidas</th><th className="num">Saldos</th><th>Observações</th></tr></thead>
            <tbody>{plans.map((p) => (
              <tr key={p.fileName}><td>{p.fileName}</td><td>{p.result.source}</td><td className="num">{p.newRows}</td><td className="num">{p.dupRows}</td>
                <td className="num">{p.result.checkpoints.length}</td>
                <td>{[...p.result.warnings, ...p.unknownRefs.map((r) => `a conta ${r} será criada`)].join('; ')}</td></tr>
            ))}</tbody>
          </table></div>
          <ImportCategories ctx={ctx} plans={plans} choices={choices} setChoices={setChoices} busy={busy} />
          <div className="row" style={{ marginTop: 10 }}>
            <button className="primary" onClick={run} disabled={busy}>Importar {totalNew} linhas{Object.values(choices).filter((c) => c.categoryId).length ? ` e criar ${Object.values(choices).filter((c) => c.categoryId).length} regras` : ''}</button>
            <button onClick={() => setPlans([])} disabled={busy}>Cancelar</button>
          </div>
        </>}
        {done && <p className="pos">{done}</p>}
      </div>
      <AiSuggestions ctx={ctx} />
      <LearnedRules ctx={ctx} />
    </div>
  )
}
