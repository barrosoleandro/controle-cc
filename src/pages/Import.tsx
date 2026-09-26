import { useState } from 'react'
import type { Ctx } from '../App'
import { createAccount, deriveOpening, executeImport, loadAll, planImport, sha256, updateAccount, type ImportPlan } from '../lib/data'
import { parseStatement } from '../parsers'

/**
 * Files are parsed in the browser; only the extracted rows go to the database.
 * The original PDFs/CSVs never leave the device.
 */
export function ImportPage({ ctx }: { ctx: Ctx }) {
  const [plans, setPlans] = useState<ImportPlan[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)

  async function onFiles(files: FileList | null) {
    if (!files) return
    setBusy(true); setDone(null)
    const ps: ImportPlan[] = [], errs: string[] = []
    for (const f of [...files].sort((a, b) => Number(/\.pdf$/i.test(a.name)) - Number(/\.pdf$/i.test(b.name)))) {
      try {
        const bytes = new Uint8Array(await f.arrayBuffer())
        const { loadPdf } = await import('../lib/pdf') // pdf.js is loaded only when importing
        const res = await parseStatement(f.name, bytes, loadPdf)
        ps.push(planImport(f.name, await sha256(bytes), res, ctx.data))
      } catch (e) { errs.push((e as Error).message) }
    }
    setPlans(ps); setErrors(errs); setBusy(false)
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
      // CSV first (carries bank categories), then PDFs; reload between files so dedupe sees new rows.
      for (const p of plans) {
        total += await executeImport(planImport(p.fileName, p.sha256, p.result, data), data)
        data = await loadAll()
      }
      // Rebuild opening balances from the bank's own balances.
      for (const a of data.accounts) {
        const o = deriveOpening(a, data.transactions, data.checkpoints)
        if (o && (o.opening_balance !== a.opening_balance || o.opening_date !== a.opening_date)) await updateAccount(a.id, o)
      }
      setDone(`${total} new transactions imported. Opening balances recalculated — check Settings → Accounts for reconciliation.`)
      setPlans([])
      await ctx.reload()
    } catch (e) { setErrors([(e as Error).message]) } finally { setBusy(false) }
  }

  return (
    <div className="card">
      <h3>Import bank files</h3>
      <p className="muted">Supported: Banque BCP CSV export and monthly relevé PDF; Itaú “extrato conta” PDF. Select all files of the folder at once — duplicates are skipped automatically.</p>
      <input type="file" multiple accept=".csv,.pdf" onChange={(e) => onFiles(e.target.files)} disabled={busy} />
      {busy && <p className="muted">Working…</p>}
      {errors.map((e) => <p key={e} className="err">{e}</p>)}
      {plans.length > 0 && <>
        <div className="scroll"><table style={{ marginTop: 12 }}>
          <thead><tr><th>File</th><th>Type</th><th className="num">New</th><th className="num">Duplicates</th><th className="num">Balances</th><th>Notes</th></tr></thead>
          <tbody>{plans.map((p) => (
            <tr key={p.fileName}><td>{p.fileName}</td><td>{p.result.source}</td><td className="num">{p.newRows}</td><td className="num">{p.dupRows}</td>
              <td className="num">{p.result.checkpoints.length}</td>
              <td>{[...p.result.warnings, ...p.unknownRefs.map((r) => `new account ${r} will be created`)].join('; ')}</td></tr>
          ))}</tbody>
        </table></div>
        <div className="row" style={{ marginTop: 10 }}><button className="primary" onClick={run} disabled={busy}>Import</button><button onClick={() => setPlans([])}>Cancel</button></div>
      </>}
      {done && <p className="pos">{done}</p>}
    </div>
  )
}
