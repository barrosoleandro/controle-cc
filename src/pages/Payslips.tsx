import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import type { Ctx } from '../App'
import { saveSettings, sha256 } from '../lib/data'
import { deletePayslip, listPayslips, savePayslip, type Payslip } from '../lib/payroll'
import { money, monthLabel } from '../lib/format'
import { checkContract, DEFAULT_CONTRACT, type ContractItem } from '../domain/payroll'
import { pdfToRows } from '../parsers/pdfText'
import { looksLikePayslip, parsePayslipRows } from '../parsers/payslipPdf'

const eur = money('EUR', 2)
const f = (n: number | null | undefined) => (n === null || n === undefined ? '' : eur(n))
const STATUS = { ok: ['✔ OK', 'pos'], changed: ['≠ Mudou', 'neg'], missing: ['✖ Ausente', 'neg'] } as const

/** Monthly payslips (bulletins de paie): detail + check against the contract amounts. */
export function Payslips({ ctx }: { ctx: Ctx }) {
  const [list, setList] = useState<Payslip[] | null>(null)
  const [sel, setSel] = useState('')
  const [msgs, setMsgs] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const saved = ctx.data.settings.payroll_contract
  const [contract, setContract] = useState<ContractItem[]>(saved?.length ? saved : DEFAULT_CONTRACT)

  const load = useCallback(async () => {
    try {
      const l = await listPayslips()
      setList(l)
      setSel((s) => (s && l.some((p) => p.id === s) ? s : l[0]?.id ?? ''))
    } catch (e) {
      setError(/payslips/.test((e as Error).message)
        ? 'Tabela de holerites não encontrada: rode supabase/migrations/002_payslips.sql no SQL Editor do Supabase.'
        : (e as Error).message)
    }
  }, [])
  useEffect(() => { load() }, [load])

  async function onFiles(files: FileList | null) {
    if (!files?.length) return
    setBusy(true)
    const out: string[] = []
    const existing = new Map((list ?? []).map((p) => [p.period.slice(0, 7), p.file_sha256]))
    const { loadPdf } = await import('../lib/pdf') // pdf.js is loaded only when importing
    for (const file of [...files]) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const hash = await sha256(bytes)
        const pages = await pdfToRows(bytes, loadPdf)
        if (!looksLikePayslip(pages)) throw new Error('não parece um bulletin de paie')
        const p = parsePayslipRows(pages)
        const prev = existing.get(p.period)
        if (prev === hash) { out.push(`${file.name}: ${p.period} já importado — pulado`); continue }
        await savePayslip(p, hash)
        existing.set(p.period, hash)
        out.push(`${file.name}: ${p.period} ${prev ? 'substituído (arquivo diferente para o mesmo mês)' : 'importado'}${p.warnings.length ? ` — conferir: ${p.warnings.join('; ')}` : ''}`)
      } catch (e) { out.push(`${file.name}: ${(e as Error).message}`) }
    }
    setMsgs(out); setBusy(false)
    await load()
  }

  const cur = list?.find((p) => p.id === sel)
  const prev = list && cur ? list[list.indexOf(cur) + 1] : undefined
  const check = useMemo(() => (cur ? checkContract(cur.lines, contract) : null), [cur, contract])
  const checks = useMemo(() => new Map((list ?? []).map((p) => [p.id, checkContract(p.lines, contract).ok])), [list, contract])

  if (error) return <div className="card err">{error}</div>
  if (!list) return <div className="card muted">Carregando…</div>

  return (
    <div className="grid" style={{ gridTemplateColumns: '1fr' }}>
      <div className="card">
        <h3>Holerites</h3>
        <div className="row">
          <select value={sel} onChange={(e) => setSel(e.target.value)} disabled={!list.length}>
            {list.map((p) => <option key={p.id} value={p.id}>{monthLabel(p.period.slice(0, 7))} {checks.get(p.id) ? '✔' : '⚠'}</option>)}
          </select>
          <label className="inline"><span className="muted">Importar PDF</span>
            <input type="file" multiple accept=".pdf" onChange={(e) => { onFiles(e.target.files); e.target.value = '' }} disabled={busy} /></label>
          {cur && <button onClick={async () => { if (confirm(`Excluir o holerite de ${cur.period.slice(0, 7)}?`)) { await deletePayslip(cur.id); await load() } }}>Excluir</button>}
        </div>
        <p className="muted">Os PDFs são lidos no navegador e nunca enviados; só valores e rótulos são guardados. Um holerite por mês: reimportar o mesmo mês substitui o anterior.</p>
        {busy && <p className="muted">Processando…</p>}
        {msgs.map((m) => <p key={m} className={/imported|replaced|skipped/.test(m) && !/check:/.test(m) ? 'muted' : 'warn'}>{m}</p>)}
        {!list.length && <p>Nenhum holerite ainda — importe seus bulletins de paie (PDF).</p>}
      </div>

      {cur && check && <>
        <div className="card">
          <h3>{monthLabel(cur.period.slice(0, 7))} · {cur.employer} · pago em {cur.transfer_date ?? cur.pay_date ?? ''}</h3>
          <div className="kpis">
            {([['Bruto', cur.gross, prev?.gross], ['Líquido social', cur.net_social, prev?.net_social], ['Base tributável', cur.net_taxable, prev?.net_taxable],
              ['IR retido (PAS)', cur.pas_amount, prev?.pas_amount], ['Líquido pago', cur.net_paid, prev?.net_paid], ['Custo do empregador', cur.employer_cost, prev?.employer_cost]] as const)
              .map(([l, v, p]) => (
                <div className="kpi" key={l}><div className="l">{l}</div><div className="v">{f(v)}</div>
                  {p !== undefined && p !== null && v !== null && Math.abs(v - p) > 0.01 && <div className={`l ${v > p ? 'pos' : 'neg'}`}>{v > p ? '+' : ''}{eur(v - p)} vs mês anterior</div>}
                </div>))}
            <div className="kpi"><div className="l">Alíquota PAS</div><div className={`v ${(cur.pas_rate ?? 0) < 5 ? 'warn' : ''}`}>{cur.pas_rate ?? '–'}%</div></div>
            <div className="kpi"><div className="l">Acumulado tributável (ano)</div><div className="v">{f(cur.cumul_taxable)}</div></div>
          </div>
        </div>

        <div className="card">
          <h3>Conferência do contrato {check.ok ? <span className="pos">✔ bate</span> : <span className="neg">⚠ diferenças</span>}</h3>
          <div className="scroll"><table>
            <thead><tr><th>Código</th><th>Item</th><th className="num">Contrato</th><th className="num">Holerite</th><th className="num">Diferença</th><th>Situação</th></tr></thead>
            <tbody>{check.rows.map((r) => (
              <tr key={r.item.code}><td>{r.item.code}</td><td>{r.item.label}</td><td className="num">{eur(r.item.amount)}</td>
                <td className="num">{f(r.actual)}</td><td className="num">{r.diff ? eur(r.diff) : ''}</td>
                <td className={STATUS[r.status][1]}>{STATUS[r.status][0]}</td></tr>))}
            </tbody>
          </table></div>
          {check.extras.length > 0 && <>
            <p className="muted" style={{ marginBottom: 4 }}>Outros ganhos deste mês (fora do contrato):</p>
            <table><tbody>{check.extras.map((l, i) => <tr key={i}><td>{l.code}</td><td>{l.label}</td><td className="num">{f(l.gain)}</td></tr>)}</tbody></table>
          </>}
          <details style={{ marginTop: 10 }}>
            <summary>Editar valores do contrato</summary>
            <table><tbody>
              {contract.map((c, i) => (
                <tr key={i}>
                  <td><input value={c.code} style={{ width: 70 }} onChange={(e) => setContract(contract.map((x, j) => (j === i ? { ...x, code: e.target.value.trim() } : x)))} /></td>
                  <td><input value={c.label} onChange={(e) => setContract(contract.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} /></td>
                  <td className="num"><input type="number" step="0.01" value={c.amount} onChange={(e) => setContract(contract.map((x, j) => (j === i ? { ...x, amount: Number(e.target.value) } : x)))} /></td>
                  <td><button onClick={() => setContract(contract.filter((_, j) => j !== i))}>Remover</button></td>
                </tr>))}
            </tbody></table>
            <div className="row" style={{ marginTop: 8 }}>
              <button onClick={() => setContract([...contract, { code: '', label: '', amount: 0 }])}>Adicionar item</button>
              <button className="primary" onClick={async () => {
                const clean = contract.filter((c) => c.code && Number.isFinite(c.amount))
                await saveSettings({ payroll_contract: clean }); setContract(clean); await ctx.reload()
              }}>Salvar contrato</button>
              <button onClick={() => setContract(DEFAULT_CONTRACT)}>Voltar ao padrão</button>
            </div>
          </details>
        </div>

        <div className="card">
          <h3>Detalhe do holerite</h3>
          <div className="scroll"><table>
            <thead><tr><th>Código</th><th>Linha</th><th className="num hide-sm">Base</th><th className="num hide-sm">Taxa</th><th className="num">Ganhos</th><th className="num">Descontos</th><th className="num hide-sm">Empregador</th></tr></thead>
            <tbody>{cur.lines.map((l, i) => {
              const head = l.section && l.section !== cur.lines[i - 1]?.section
              const strong = l.code?.startsWith('/') || /^TOTAL/i.test(l.label)
              return (<Fragment key={i}>
                {head && <tr><td colSpan={7} className="muted"><b>{l.section}</b></td></tr>}
                <tr style={strong ? { fontWeight: 600 } : undefined}>
                  <td>{l.code}</td><td>{l.label}{l.nonTaxable ? ' *' : ''}</td>
                  <td className="num hide-sm">{f(l.base)}</td><td className="num hide-sm">{l.rate ?? ''}</td>
                  <td className="num">{f(l.gain)}</td><td className="num">{f(l.deduction)}</td><td className="num hide-sm">{f(l.employer)}</td>
                </tr>
              </Fragment>)
            })}
              <tr><td></td><td>Líquido antes do IR</td><td className="hide-sm" /><td className="hide-sm" /><td className="num">{f(cur.net_before_tax)}</td><td /><td className="hide-sm" /></tr>
              <tr><td></td><td>IR retido na fonte (PAS {cur.pas_rate ?? '–'}% on {f(cur.net_taxable)})</td><td className="hide-sm" /><td className="hide-sm" /><td /><td className="num">{f(cur.pas_amount)}</td><td className="hide-sm" /></tr>
              <tr style={{ fontWeight: 600 }}><td></td><td>Líquido pago</td><td className="hide-sm" /><td className="hide-sm" /><td className="num">{f(cur.net_paid)}</td><td /><td className="hide-sm" /></tr>
            </tbody>
          </table></div>
          <p className="muted">* ganhos não sujeitos ao IR / descontos não dedutíveis.</p>
        </div>
      </>}

      {list.length > 0 && <div className="card">
        <h3>Todos os meses</h3>
        <div className="scroll"><table>
          <thead><tr><th>Mês</th><th className="num">Bruto</th><th className="num hide-sm">Base tributável</th><th className="num">PAS</th><th className="num">Líquido pago</th><th>Contrato</th></tr></thead>
          <tbody>{list.map((p) => (
            <tr key={p.id} onClick={() => setSel(p.id)} style={{ cursor: 'pointer', fontWeight: p.id === sel ? 600 : undefined }}>
              <td>{monthLabel(p.period.slice(0, 7))}</td><td className="num">{f(p.gross)}</td><td className="num hide-sm">{f(p.net_taxable)}</td>
              <td className="num">{f(p.pas_amount)}</td><td className="num">{f(p.net_paid)}</td>
              <td className={checks.get(p.id) ? 'pos' : 'neg'}>{checks.get(p.id) ? '✔' : '⚠'}</td></tr>))}
          </tbody>
        </table></div>
      </div>}
    </div>
  )
}
