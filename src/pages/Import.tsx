import { useEffect, useRef, useState } from 'react'
import type { Ctx } from '../App'
import { addRule, deriveOpening, ensureAccounts, executeImport, importedHashes, linkCardPayments, loadAll, pendingOf, planImport, sha256, updateAccount, type ImportPlan, type Pending } from '../lib/data'
import { money } from '../lib/format'
import { saveMerchantProfiles } from '../lib/ai'
import { parseStatement } from '../parsers'
import { LearnedRules } from '../components/LearnedRules'
import { AiSuggestions } from '../components/AiSuggestions'
import { ImportCategories } from '../components/ImportCategories'
import { ImportHistory } from '../components/ImportHistory'
import { Icon } from '../components/Icons'
import { Help } from '../components/Page'

const SUPPORTED = /\.(csv|pdf|xlsx)$/i

/** Category picked for a merchant before importing (by hand or pre-filled by the AI). */
export interface Choice { categoryId: string; description?: string; confidence?: number; source: 'ai' | 'manual' }

/** A file picked through a folder the app may write to, so it can be moved once imported. */
interface Origin { dir: FileSystemDirectoryHandle; name: string }

/** Subfolder that receives the files already imported. */
const DONE_DIR = 'processado'

/** Moves a file into the `processado` subfolder of its folder (copy, then remove: works in every Chromium). */
async function moveToDone({ dir, name }: Origin, file: File) {
  const dest = await dir.getDirectoryHandle(DONE_DIR, { create: true })
  let target = name
  try { await dest.getFileHandle(target); target = `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${name}` } catch { /* name is free */ }
  const out = await (await dest.getFileHandle(target, { create: true })).createWritable()
  await file.stream().pipeTo(out)
  await dir.removeEntry(name)
}

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
  // Repeated rows are never written silently. Skipping them is the default: a statement that
  // overlaps the last one is the normal case, and requiring a choice first left the import
  // button disabled behind a tooltip, so new rows looked like they would not load.
  const [dupDecision, setDupDecision] = useState<'skip' | 'import' | 'pick'>('skip')
  const [keepDups, setKeepDups] = useState<Set<string>>(() => new Set())
  const dirRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const doneRef = useRef<HTMLDivElement>(null)
  // Files that came from a folder opened with write access, by name (only those can be moved).
  const origins = useRef(new Map<string, Origin & { file: File }>())
  // Files skipped because an earlier import already has them: they are done too.
  const [seenNames, setSeenNames] = useState<string[]>([])

  useEffect(() => { if (done) doneRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [done])

  // webkitdirectory is not in React's prop types; set it on the element itself.
  useEffect(() => {
    dirRef.current?.setAttribute('webkitdirectory', '')
    dirRef.current?.setAttribute('directory', '')
  }, [])

  /** Opens a folder with write access (Chrome/Edge), so imported files can go to `processado`. */
  async function pickWritableFolder() {
    const pick = (window as unknown as { showDirectoryPicker?: (o: { mode: 'readwrite' }) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker
    if (!pick) { setErrors(['Este navegador não deixa o app mover arquivos. Use o Chrome ou o Edge no computador.']); return }
    try {
      const dir = await pick.call(window, { mode: 'readwrite' })
      const files: File[] = [], found = new Map<string, Origin & { file: File }>()
      for await (const [name, h] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
        if (h.kind !== 'file' || !SUPPORTED.test(name)) continue
        const file = await (h as FileSystemFileHandle).getFile()
        files.push(file); found.set(name, { dir, name, file })
      }
      await onFiles(files, found)
    } catch (e) { if ((e as Error).name !== 'AbortError') setErrors([(e as Error).message]) }
  }

  /** Sends the imported files to `processado`; returns a sentence about it (or nothing). */
  async function archive(names: string[]) {
    const movable = names.filter((n) => origins.current.has(n))
    if (!movable.length) return ''
    let moved = 0
    const failed: string[] = []
    for (const n of movable) {
      const o = origins.current.get(n)!
      try { await moveToDone(o, o.file); origins.current.delete(n); moved++ }
      catch (e) { failed.push(`${n} (${(e as Error).message})`) }
    }
    return `${moved} arquivo(s) movido(s) para a subpasta “${DONE_DIR}”.${failed.length ? ` Não consegui mover: ${failed.join('; ')}.` : ''}`
  }

  async function onFiles(files: FileList | File[] | null, from?: Map<string, Origin & { file: File }>) {
    if (!files?.length) return
    origins.current = from ?? new Map(); setSeenNames([])
    setBusy(true); setDone(null); setErrors([]); setPlans([]); setChoices({}); setDupDecision('skip'); setKeepDups(new Set())
    const ps: ImportPlan[] = [], errs: string[] = []
    const pending: Pending[] = [] // rows of the files planned so far
    let ignored = 0, duplicateFiles = 0
    const already: string[] = []
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
        if (seen.has(hash)) { duplicateFiles++; already.push(f.name); continue }
        seen.add(hash)
        const { loadPdf } = await import('../lib/pdf') // pdf.js is loaded only when importing
        const res = await parseStatement(f.name, bytes, loadPdf)
        const plan = planImport(f.name, hash, res, ctx.data, pending)
        ps.push(plan)
        pending.push(...pendingOf(plan))
      } catch (e) { errs.push(`${f.name}: ${(e as Error).message}`) }
    }
    setPlans(ps); setErrors(errs); setSkipped({ ignored, duplicateFiles }); setSeenNames(already)
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
      let okFiles = 0
      const okNames: string[] = []
      const falhas: string[] = []
      // Re-plan against freshly loaded data between files, so dedupe sees the rows the
      // previous file just inserted. One bad file no longer discards the whole run: it is
      // reported and the remaining files still go in — it matters with a whole folder.
      let i = 0
      for (const p of plans) {
        setProgress(`Importando ${++i} de ${plans.length}: ${p.fileName}`)
        try {
          const fresh = planImport(p.fileName, p.sha256, p.result, data)
          const forced = new Set(dupDecision === 'import' ? p.duplicates.map((d) => d.id) : dupDecision === 'pick' ? p.duplicates.filter((d) => keepDups.has(d.id)).map((d) => d.id) : [])
          total += await executeImport({ ...fresh, duplicates: p.duplicates }, data, forced)
          okFiles++; okNames.push(p.fileName)
          data = await loadAll()
        } catch (e) { falhas.push(`${p.fileName}: ${(e as Error).message}`) }
      }
      // The rows are written by now, so everything below is a finishing touch: a failure
      // there becomes a warning instead of hiding an import that did happen.
      const avisos: string[] = []
      setProgress('Recalculando saldos iniciais…')
      try {
        for (const a of data.accounts) {
          const o = deriveOpening(a, data.transactions, data.checkpoints)
          if (o && (o.opening_balance !== a.opening_balance || o.opening_date !== a.opening_date)) await updateAccount(a.id, o)
        }
      } catch (e) { avisos.push(`os saldos iniciais não foram recalculados (${(e as Error).message})`) }
      // Card bills now in the app: their payments in the paying account become transfers.
      let linked = 0
      try { linked = await linkCardPayments(await loadAll()) }
      catch (e) { avisos.push(`os pagamentos de fatura não foram marcados como transferência (${(e as Error).message})`) }

      // Only after everything is written: files that failed stay where they are.
      let archived = ''
      try { archived = await archive([...okNames, ...seenNames]) } catch (e) { avisos.push(`os arquivos não foram movidos (${(e as Error).message})`) }
      setSeenNames([])

      setDone([
        `${total} ${total === 1 ? 'lançamento novo importado' : 'lançamentos novos importados'} de ${okFiles} de ${plans.length} arquivo(s).`,
        chosen.length ? `${chosen.length} regra(s) criada(s) para os próximos imports.` : '',
        archived,
        linked ? `${linked} pagamento(s) de fatura marcados como transferência.` : '',
        falhas.length ? `${falhas.length} arquivo(s) falharam e não entraram — veja a lista acima.` : '',
        avisos.length ? `Atenção: ${avisos.join('; ')}.` : 'Saldos iniciais recalculados — confira a conciliação em Ajustes → Contas.',
      ].filter(Boolean).join(' '))
      setErrors(falhas)
      setPlans([]); setChoices({}); setDupDecision('skip'); setKeepDups(new Set())
      await ctx.reload()
    } catch (e) { setErrors([(e as Error).message]) } finally { setProgress(null); setBusy(false) }
  }

  const totalNew = plans.reduce((s, p) => s + p.newRows, 0)
  const totalDup = plans.reduce((s, p) => s + p.dupRows, 0)
  const allDups = plans.flatMap((p) => p.duplicates.map((d) => ({ ...d, file: p.fileName })))
  const keptCount = dupDecision === 'import' ? allDups.length : dupDecision === 'pick' ? keepDups.size : 0
  const dupsInBase = allDups.filter((d) => d.inBase).length
  const dupsBetweenFiles = allDups.length - dupsInBase

  return (
    <div className="grid">
      <div className="card" style={{ gridColumn: '1/-1' }}>
        <div className={`drop ${over ? 'over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); if (!busy) setOver(true) }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); if (!busy) onFiles(e.dataTransfer.files) }}>
          <span className="empty-icon"><Icon name="importar" size={28} /></span>
          <strong>Arraste os extratos para cá</strong>
          <span className="muted">ou escolha no computador — pode ser vários de uma vez</span>
          <div className="row">
            <button className="primary" onClick={() => fileRef.current?.click()} disabled={busy}><Icon name="importar" size={16} /> Escolher arquivos</button>
            <button onClick={() => dirRef.current?.click()} disabled={busy}><Icon name="pasta" size={16} /> Escolher uma pasta</button>
            {'showDirectoryPicker' in window && <button onClick={pickWritableFolder} disabled={busy} title={`Depois de importar, os arquivos vão para a subpasta “${DONE_DIR}”`}><Icon name="pasta" size={16} /> Pasta com “{DONE_DIR}”</button>}
          </div>
          <input ref={fileRef} type="file" multiple accept=".csv,.pdf,.xlsx" onChange={(e) => { onFiles(e.target.files); e.target.value = '' }} disabled={busy} />
          <input ref={dirRef} type="file" multiple onChange={(e) => { onFiles(e.target.files); e.target.value = '' }} disabled={busy} />
          <div className="formats">
            {['BCP · CSV e PDF', 'CCF · PDF', 'Itaú conta · PDF', 'Itaú cartão · PDF e Excel', 'Millennium · PDF'].map((f) => <span key={f} className="badge">{f}</span>)}
          </div>
        </div>
        <div style={{ marginTop: 12 }} />
        <Help title="Detalhes sobre a importação">
          <p>Os arquivos são lidos no navegador; só as linhas extraídas vão para a base — os PDFs e CSVs nunca saem do aparelho.</p>
          <p>Itaú conta: extrato do app ou o Extrato Mensal. Millennium: extrato combinado. Se alguma linha já existir (mesma conta, data, valor e estabelecimento, de qualquer arquivo), o app pergunta o que fazer antes de gravar.</p>
          <p>“Pasta com {DONE_DIR}” (Chrome e Edge) lê os extratos da pasta escolhida e, terminada a importação, move para a subpasta “{DONE_DIR}” os que entraram — e os que já tinham sido importados antes. Os que deram erro ficam onde estão. O navegador pede permissão de escrita na pasta.</p>
          <p>A opção de pasta varre todas as subpastas e ignora o que não for CSV, PDF ou XLSX. No iPhone/iPad o Safari não permite
            selecionar pastas — use a seleção de arquivos, ou faça a importação em massa no computador.</p>
        </Help>
        {(progress || busy) && <div className="loading" style={{ justifyContent: 'flex-start', margin: '12px 0' }}><span className="spinner" />{progress ?? 'Processando…'}</div>}

        {(skipped.ignored > 0 || skipped.duplicateFiles > 0) && !busy && (
          <p className="muted">
            {skipped.duplicateFiles > 0 && `${skipped.duplicateFiles} arquivo(s) já importados anteriormente foram pulados. `}
            {skipped.ignored > 0 && `${skipped.ignored} arquivo(s) fora do formato CSV/PDF/XLSX foram ignorados.`}
          </p>
        )}
        {errors.length > 0 && <details>
          <summary className="err">{errors.length} arquivo(s) com problema</summary>
          {errors.slice(0, 30).map((e) => <p key={e} className="err" style={{ fontSize: 13 }}>{e}</p>)}
          {errors.length > 30 && <p className="muted">e mais {errors.length - 30}…</p>}
        </details>}

        {plans.length > 0 && <>
          <p><strong>{plans.length} arquivos prontos</strong> · {totalNew} linhas novas · {totalDup} repetidas</p>
          <div className="scroll"><table style={{ marginTop: 12 }}>
            <thead><tr><th>Arquivo</th><th>Tipo</th><th className="num">Novas</th><th className="num">Repetidas</th><th className="num">Saldos</th><th>Observações</th></tr></thead>
            <tbody>{plans.map((p) => (
              <tr key={p.fileName}><td>{p.fileName}</td><td>{p.result.source}</td><td className="num">{p.newRows}</td><td className="num">{p.dupRows}</td>
                <td className="num">{p.result.checkpoints.length}</td>
                <td>{[...p.result.warnings, ...p.unknownRefs.map((r) => `a conta ${r} será criada`)].join('; ')}</td></tr>
            ))}</tbody>
          </table></div>
          {allDups.length > 0 && (
            <div className="alert warn" style={{ display: 'block', marginTop: 12 }}>
              <strong>{allDups.length} linha(s) repetida(s)</strong> (mesma conta, data, valor e estabelecimento):
              <ul style={{ margin: '4px 0 6px 18px' }}>
                {dupsInBase > 0 && <li>{dupsInBase} já estão gravadas na base e ficam como estão: pulá-las não altera nada no que já foi importado;</li>}
                {dupsBetweenFiles > 0 && <li>{dupsBetweenFiles} aparecem em dois arquivos desta seleção (por exemplo, o extrato do app e o Extrato Mensal
                  do mesmo mês). A primeira cópia é importada normalmente; a pergunta é só sobre a segunda.</li>}
              </ul>
              O que fazer com as cópias repetidas?
              <div className="row" style={{ marginTop: 6 }}>
                <label className="inline"><input type="radio" name="dups" checked={dupDecision === 'skip'} onChange={() => setDupDecision('skip')} disabled={busy} /> Pular todas (recomendado)</label>
                <label className="inline"><input type="radio" name="dups" checked={dupDecision === 'import'} onChange={() => setDupDecision('import')} disabled={busy} /> Importar todas mesmo assim</label>
                <label className="inline"><input type="radio" name="dups" checked={dupDecision === 'pick'} onChange={() => setDupDecision('pick')} disabled={busy} /> Escolher linha a linha</label>
              </div>
              <details open={dupDecision === 'pick'}>
                <summary className="muted">Ver as linhas repetidas</summary>
                <div className="scroll" style={{ maxHeight: 320, overflowY: 'auto' }}><table>
                  <thead><tr>{dupDecision === 'pick' && <th>Importar</th>}<th>Arquivo</th><th>Data</th><th>Descrição</th><th className="num">Valor</th><th className="hide-sm">Igual a</th></tr></thead>
                  <tbody>{allDups.map((d) => (
                    <tr key={d.id}>
                      {dupDecision === 'pick' && <td><input type="checkbox" checked={keepDups.has(d.id)} disabled={busy} aria-label={`Importar ${d.tx.description}`}
                        onChange={() => setKeepDups((prev) => { const n = new Set(prev); if (n.has(d.id)) n.delete(d.id); else n.add(d.id); return n })} /></td>}
                      <td style={{ fontSize: 12, wordBreak: 'break-all' }}>{d.file}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{d.tx.bookingDate}</td>
                      <td>{d.tx.description}</td>
                      <td className="num">{money(d.tx.currency, 2)(d.tx.amount)}</td>
                      <td className="hide-sm muted" style={{ fontSize: 12 }}>{d.matches}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              </details>
            </div>
          )}
          <ImportCategories ctx={ctx} plans={plans} choices={choices} setChoices={setChoices} busy={busy} />
          <div className="row" style={{ marginTop: 10 }}>
            <button className="primary" onClick={run} disabled={busy}>
              Importar {totalNew + keptCount} linhas{keptCount ? ` (${keptCount} repetidas mantidas)` : ''}{Object.values(choices).filter((c) => c.categoryId).length ? ` e criar ${Object.values(choices).filter((c) => c.categoryId).length} regras` : ''}</button>
            <button onClick={() => setPlans([])} disabled={busy}>Cancelar</button>
          </div>
        </>}
        {done && (
          <div className="alert ok" ref={doneRef} style={{ display: 'block', marginTop: 12 }}>
            <strong>✔ Importação concluída.</strong> {done}
            <div className="row" style={{ marginTop: 8 }}>
              <button onClick={() => setDone(null)}>Entendi</button>
            </div>
          </div>
        )}
      </div>
      <AiSuggestions ctx={ctx} />
      <ImportHistory ctx={ctx} />
      <LearnedRules ctx={ctx} />
    </div>
  )
}
