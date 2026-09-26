import { useEffect, useRef, useState } from 'react'
import type { Ctx } from '../App'
import { createAccount, deriveOpening, executeImport, importedHashes, loadAll, planImport, sha256, updateAccount, type ImportPlan } from '../lib/data'
import { parseStatement } from '../parsers'
import { LearnedRules } from '../components/LearnedRules'
import { AiSuggestions } from '../components/AiSuggestions'
import { ImportCategories } from '../components/ImportCategories'

const SUPPORTED = /\.(csv|pdf)$/i

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
  const dirRef = useRef<HTMLInputElement>(null)

  // webkitdirectory is not in React's prop types; set it on the element itself.
  useEffect(() => {
    dirRef.current?.setAttribute('webkitdirectory', '')
    dirRef.current?.setAttribute('directory', '')
  }, [])

  async function onFiles(files: FileList | null) {
    if (!files?.length) return
    setBusy(true); setDone(null); setErrors([]); setPlans([])
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
      // Create accounts for unknown account numbers first.
      const unknown = [...new Set(plans.flatMap((p) => p.unknownRefs))]
      for (const ref of unknown) {
        const isItau = ref.includes('/')
        await createAccount({ name: `${isItau ? 'Itaú' : 'BCP'} ${ref}`, bank: isItau ? 'ITAU' : 'BCP', currency: isItau ? 'BRL' : 'EUR', type: 'checking', external_ref: ref })
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
      setDone(`${total} lançamentos novos importados de ${plans.length} arquivos. Saldos iniciais recalculados — confira a conciliação em Ajustes → Contas.`)
      setPlans([])
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
          Aceita o CSV do Banque BCP, o relevé mensal do BCP em PDF e o extrato de conta do Itaú em PDF.
          Pode selecionar tudo de uma vez: linhas repetidas são descartadas sozinhas.
        </p>
        <div className="row">
          <label className="inline">Arquivos
            <input type="file" multiple accept=".csv,.pdf" onChange={(e) => onFiles(e.target.files)} disabled={busy} />
          </label>
          <label className="inline">Pasta inteira
            <input ref={dirRef} type="file" multiple onChange={(e) => onFiles(e.target.files)} disabled={busy} />
          </label>
        </div>
        <p className="muted" style={{ fontSize: 12 }}>
          A opção de pasta varre todas as subpastas e ignora o que não for CSV nem PDF. No iPhone/iPad o Safari não permite
          selecionar pastas — use a seleção de arquivos, ou faça a importação em massa no computador.
        </p>
        {progress && <p className="muted">{progress}</p>}
        {busy && !progress && <p className="muted">Processando…</p>}

        {(skipped.ignored > 0 || skipped.duplicateFiles > 0) && !busy && (
          <p className="muted">
            {skipped.duplicateFiles > 0 && `${skipped.duplicateFiles} arquivo(s) já importados anteriormente foram pulados. `}
            {skipped.ignored > 0 && `${skipped.ignored} arquivo(s) fora do formato CSV/PDF foram ignorados.`}
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
          <ImportCategories ctx={ctx} plans={plans} />
          <div className="row" style={{ marginTop: 10 }}>
            <button className="primary" onClick={run} disabled={busy}>Importar {totalNew} linhas</button>
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
