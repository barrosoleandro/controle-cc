import { useEffect, useRef, useState } from 'react'
import type { Ctx } from '../App'
import { importAuditRows, listImports, loadAll, type AppData } from '../lib/data'
import { money } from '../lib/format'
import { parseStatement } from '../parsers'
import { enrich } from '../domain/analytics'
import { auditImportLog, auditRows, unpairedTransfers, type AuditRow, type LogAudit, type PairTx } from '../domain/audit'
import type { Currency, ParseResult } from '../domain/types'

const LABEL: Record<AuditRow['status'], string> = { ok: 'na base', similar: 'outra descrição na base', missing: 'faltando', noAccount: 'conta não cadastrada' }
const MONTHS_BACK = 12 // transfers checked for the last 12 months
// Phone browsers (Safari on iPhone, most on Android) open no folder picker: the button would do nothing there.
const canPickFolder = typeof window !== 'undefined' && !window.matchMedia('(pointer: coarse)').matches && 'webkitdirectory' in HTMLInputElement.prototype

interface FileAudit { name: string; source: ParseResult['source']; rows: (AuditRow & { reason?: string; matches?: string })[] }

/**
 * Checks imports against the database itself (freshly read, not the screen's copy): from the
 * import log (counts per file, and the skipped rows it keeps since migration 007) or from the
 * files picked again, each row is there as is, there with another description, or missing; and
 * transfers between own accounts must have money out of one account and into another.
 */
export function ImportAudit({ ctx }: { ctx: Ctx }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const [files, setFiles] = useState<FileAudit[] | null>(null)
  const [withSimilar, setWithSimilar] = useState(false)
  const [logs, setLogs] = useState<{ checked: number; issues: LogAudit[] } | null>(null)
  const [unpaired, setUnpaired] = useState<(PairTx & { accountName: string })[] | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const dirRef = useRef<HTMLInputElement>(null)
  // webkitdirectory is not in React's prop types; set it on the element itself.
  useEffect(() => { dirRef.current?.setAttribute('webkitdirectory', '') }, [])

  const storedOf = (data: AppData) => {
    const acc = new Map(data.accounts.map((a) => [a.id, a]))
    return data.transactions.map((t) => ({ id: t.id, accountRef: acc.get(t.account_id)?.external_ref ?? '', accountName: acc.get(t.account_id)?.name ?? '?', date: t.booking_date, amount: Number(t.amount), description: t.description, importId: t.import_id }))
  }

  /** From the import log alone: no file needed. */
  async function auditLog() {
    setBusy('Lendo o histórico e a base…'); setErro(null); setOk(null); setFiles(null); setLogs(null)
    try {
      const [data, records] = await Promise.all([loadAll(), listImports()])
      const res = auditImportLog(records, storedOf(data), new Set(data.accounts.map((a) => a.external_ref)))
      setLogs({ checked: res.length, issues: res.filter((a) => a.notWritten || a.lost || a.rows.some((x) => x.status !== 'ok')) })
      // The logged skipped rows go through the same review and "Gravar" as the files.
      setFiles(res.filter((a) => a.rows.length).map((a) => ({ name: a.record.file_name, source: a.record.source as ParseResult['source'], rows: a.rows })))
    } catch (e) { setErro(`Não foi possível auditar: ${(e as Error).message}`) }
    finally { setBusy(null) }
  }

  async function auditFiles(list: FileList | null) {
    if (!list?.length) return
    setBusy('Lendo a base…'); setErro(null); setOk(null); setFiles(null); setLogs(null)
    try {
      const data = await loadAll()
      const stored = storedOf(data)
      const refs = new Set(data.accounts.map((a) => a.external_ref))
      const out: FileAudit[] = []
      // A folder brings everything in it: only statements are read.
      for (const f of [...list].filter((x) => /\.(csv|pdf|xlsx)$/i.test(x.name))) {
        setBusy(`Conferindo ${f.name}…`)
        const { loadPdf } = await import('../lib/pdf')
        const res = await parseStatement(f.name, new Uint8Array(await f.arrayBuffer()), loadPdf)
        if (res.payslip) continue
        out.push({ name: f.name, source: res.source, rows: auditRows(res.transactions, stored, refs) })
      }
      setFiles(out)
    } catch (e) { setErro(`Não foi possível auditar: ${(e as Error).message}`) }
    finally { setBusy(null) }
  }

  async function importMissing() {
    if (!files) return
    setBusy('Gravando as linhas faltantes…'); setErro(null)
    try {
      let n = 0
      for (const f of files) {
        const rows = f.rows.filter((r) => r.status === 'missing' || (withSimilar && r.status === 'similar')).map((r) => r.tx)
        if (rows.length) n += await importAuditRows(f.name, f.source, rows, await loadAll())
      }
      await ctx.reload()
      setOk(`${n} linha(s) gravada(s). Confira de novo para ver o resultado.`); setFiles(null); setLogs(null)
    } catch (e) { setErro(`Não foi possível gravar: ${(e as Error).message}`) }
    finally { setBusy(null) }
  }

  async function checkTransfers() {
    setBusy('Conferindo transferências…'); setErro(null)
    try {
      const data = await loadAll()
      const since = new Date(); since.setMonth(since.getMonth() - MONTHS_BACK)
      const from = since.toISOString().slice(0, 10)
      const names = new Map(data.accounts.map((a) => [a.id, a.name]))
      const txs = enrich(data.transactions, data.categories, data.accounts, ctx.fx, ctx.currency)
        .filter((t) => t.booking_date >= from)
        .map((t) => ({ id: t.id, account_id: t.account_id, date: t.booking_date, amount: Number(t.amount), currency: t.currency, description: t.description, kind: t.kind }))
      const convert = (amount: number, f: string, to: string, date: string) => ctx.fx.convert(amount, f as Currency, to as Currency, date)
      setUnpaired(unpairedTransfers(txs, convert).map((t) => ({ ...t, accountName: names.get(t.account_id) ?? '?' })).sort((a, b) => b.date.localeCompare(a.date)))
    } catch (e) { setErro(`Não foi possível conferir: ${(e as Error).message}`) }
    finally { setBusy(null) }
  }

  const problems = files?.flatMap((f) => f.rows.filter((r) => r.status !== 'ok').map((r) => ({ ...r, file: f.name }))) ?? []
  const missing = problems.filter((r) => r.status === 'missing').length
  const similar = problems.filter((r) => r.status === 'similar').length
  const toWrite = missing + (withSimilar ? similar : 0)

  return (
    <div className="card" style={{ gridColumn: '1/-1' }}>
      <h3>Auditoria</h3>
      <p className="muted" style={{ fontSize: 13 }}>Confere direto na base, não na cópia da tela. Nada é importado de novo: só as linhas que você mandar gravar.</p>
      <div className="row">
        <button className="primary" onClick={auditLog} disabled={!!busy}>Auditar pelo histórico</button>
        <button onClick={() => fileRef.current?.click()} disabled={!!busy}>Auditar com os arquivos</button>
        {canPickFolder && <button onClick={() => dirRef.current?.click()} disabled={!!busy} title="Por exemplo a pasta “processado”, para onde a importação move os extratos">Auditar uma pasta</button>}
        <button onClick={checkTransfers} disabled={!!busy}>Conferir transferências entre contas</button>
        <input ref={fileRef} type="file" multiple accept=".csv,.pdf,.xlsx" hidden onChange={(e) => { auditFiles(e.target.files); e.target.value = '' }} />
        <input ref={dirRef} type="file" multiple hidden onChange={(e) => { auditFiles(e.target.files); e.target.value = '' }} />
      </div>
      {!canPickFolder && <p className="muted" style={{ fontSize: 12 }}>No celular não dá para escolher uma pasta: em “Auditar com os arquivos”, use “Selecionar” no seletor e marque vários extratos de uma vez — ou faça a auditoria de uma pasta no computador.</p>}
      {busy && <div className="loading" style={{ justifyContent: 'flex-start', margin: '12px 0' }}><span className="spinner" />{busy}</div>}
      {erro && <p className="err">{erro}</p>}
      {ok && <p className="pos">✔ {ok}</p>}

      {logs && (logs.issues.length === 0
        ? <p className="pos" style={{ marginTop: 12 }}>✔ {logs.checked} importação(ões) conferida(s): toda linha gravada está na base e nenhuma ficou de fora.</p>
        : <>
          <p style={{ marginTop: 12 }}><strong>{logs.issues.length} de {logs.checked} importação(ões) com diferença</strong> entre o arquivo, o que foi gravado e o que está na base.</p>
          <div className="scroll" style={{ maxHeight: 320, overflowY: 'auto' }}><table>
            <thead><tr><th>Arquivo</th><th className="hide-sm">Importado em</th><th className="num">No arquivo</th><th className="num">Gravadas</th><th className="num">Na base</th><th className="num">Puladas</th><th className="num">Sumiram</th></tr></thead>
            <tbody>{logs.issues.map((a) => (
              <tr key={a.record.id}>
                <td style={{ wordBreak: 'break-all' }}>{a.record.file_name}{a.notWritten > 0 && !a.record.skipped?.length && <div className="muted" style={{ fontSize: 12 }}>importado antes do registro das linhas puladas: para ver quais, use “Auditar com os arquivos”</div>}</td>
                <td className="hide-sm">{a.record.created_at.slice(0, 16).replace('T', ' ')}</td>
                <td className="num">{a.record.rows_total}</td><td className="num">{a.record.rows_inserted}</td><td className="num">{a.inBase}</td>
                <td className={`num ${a.notWritten ? 'warn' : ''}`}>{a.notWritten}</td>
                <td className={`num ${a.lost ? 'neg' : ''}`} title="Gravadas segundo o histórico, mas fora da base: recusadas por ela (impressão digital repetida) ou apagadas depois">{a.lost}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </>)}

      {files && <>
        {!logs && <div className="scroll"><table style={{ marginTop: 12 }}>
          <thead><tr><th>Arquivo</th><th className="num">Linhas</th><th className="num">Na base</th><th className="num">Outra descrição</th><th className="num">Faltando</th><th className="num">Sem conta</th></tr></thead>
          <tbody>{files.map((f) => {
            const n = (s: AuditRow['status']) => f.rows.filter((r) => r.status === s).length
            return <tr key={f.name}><td style={{ wordBreak: 'break-all' }}>{f.name}</td><td className="num">{f.rows.length}</td><td className="num">{n('ok')}</td>
              <td className={`num ${n('similar') ? 'warn' : ''}`}>{n('similar')}</td><td className={`num ${n('missing') ? 'neg' : ''}`}>{n('missing')}</td><td className={`num ${n('noAccount') ? 'neg' : ''}`}>{n('noAccount')}</td></tr>
          })}</tbody>
        </table></div>}
        {problems.length === 0 ? (!logs && <p className="pos">✔ Todas as linhas dos arquivos estão na base, com a mesma descrição.</p>) : <>
          <div className="scroll" style={{ maxHeight: 360, overflowY: 'auto' }}><table style={{ marginTop: 12 }}>
            <thead><tr><th>Situação</th><th>Data</th><th>Descrição no arquivo</th><th className="num">Valor</th><th>Na base</th></tr></thead>
            <tbody>{problems.map((r, i) => (
              <tr key={i}>
                <td className={r.status === 'similar' ? 'warn' : 'neg'} style={{ whiteSpace: 'nowrap' }}>{LABEL[r.status]}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{r.tx.bookingDate}</td>
                <td>{r.tx.description}<div className="muted" style={{ fontSize: 12, wordBreak: 'break-all' }}>{r.file} · conta {r.tx.accountRef || '?'}{r.reason && ` · pulada na importação: ${r.reason}${r.matches ? ` (${r.matches})` : ''}`}</div></td>
                <td className="num">{money(r.tx.currency, 2)(r.tx.amount)}</td>
                <td className="muted" style={{ fontSize: 13 }}>{r.match ? `${r.match.description} · ${r.match.accountName}` : r.status === 'noAccount' ? 'importe pela tela acima para criar a conta' : '—'}</td>
              </tr>
            ))}</tbody>
          </table></div>
          {similar > 0 && <label className="inline" style={{ marginTop: 8 }}><input type="checkbox" checked={withSimilar} onChange={() => setWithSimilar(!withSimilar)} />
            Gravar também as {similar} com outra descrição (só se a linha da base for <em>outra</em> operação, não a mesma escrita de outro jeito)</label>}
          {toWrite > 0 && <div className="row" style={{ marginTop: 8 }}><button className="primary" onClick={importMissing} disabled={!!busy}>Gravar {toWrite} linha(s) na base</button></div>}
        </>}
      </>}

      {unpaired && (unpaired.length === 0
        ? <p className="pos" style={{ marginTop: 12 }}>✔ Toda transferência dos últimos {MONTHS_BACK} meses tem a saída numa conta e a entrada em outra.</p>
        : <>
          <p style={{ marginTop: 12 }}><strong>{unpaired.length} transferência(s) sem o outro lado</strong> nos últimos {MONTHS_BACK} meses: saiu de uma conta e não entrou em nenhuma outra sua (ou o contrário), até 5 dias de diferença.
            <span className="muted"> Falta importar o extrato da outra conta, a linha foi pulada, ou o destino é de terceiros (então a categoria não é transferência).</span></p>
          <div className="scroll" style={{ maxHeight: 360, overflowY: 'auto' }}><table>
            <thead><tr><th>Data</th><th>Conta</th><th>Descrição</th><th className="num">Valor</th></tr></thead>
            <tbody>{unpaired.map((t) => (
              <tr key={t.id}><td style={{ whiteSpace: 'nowrap' }}>{t.date}</td><td>{t.accountName}</td><td>{t.description}<div className="muted" style={{ fontSize: 12 }}>{t.amount > 0 ? 'entrou: falta a saída em outra conta' : 'saiu: falta a entrada em outra conta'}</div></td>
                <td className={`num ${t.amount < 0 ? 'neg' : 'pos'}`}>{money(t.currency as Currency, 2)(t.amount)}</td></tr>
            ))}</tbody>
          </table></div>
        </>)}
    </div>
  )
}
