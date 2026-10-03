import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Ctx } from '../App'
import { saveSettings, sha256 } from '../lib/data'
import { deletePayslip, listPayslips, savePayslip, type Payslip } from '../lib/payroll'
import { money, monthLabel } from '../lib/format'
import { checkContract, comparePayslips, DEFAULT_CONTRACT, type ContractItem, type LineDiff } from '../domain/payroll'
import { inflationPrompt, payslipPrompt } from '../domain/localAi'
import { HICP_GEO, hicpUrl, mergeOfficial, parseHicp } from '../domain/hicp'
import { ExplicarIA } from '../components/ExplicarIA'
import { pdfToRows } from '../parsers/pdfText'
import { CartesianGrid, Legend, Line, LineChart, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { SERIES, axis, compact, grid, tooltipStyle } from '../components/charts'
import { DEFAULT_INFLATION, ESTIMATED_FROM, payVsInflation, type InflationTable } from '../domain/inflation'
import { monthWindow } from '../domain/period'
import { today } from '../lib/hooks'
import { looksLikePayslip, parsePayslipRows } from '../parsers/payslipPdf'

const eur = money('EUR', 2)
const f = (n: number | null | undefined) => (n === null || n === undefined ? '' : eur(n))
const STATUS = { ok: ['✔ OK', 'pos'], changed: ['≠ Mudou', 'neg'], missing: ['✖ Ausente', 'neg'] } as const

type Outcome = 'importado' | 'substituído' | 'já existia' | 'não é holerite' | 'erro'
interface FileResult { file: string; outcome: Outcome; detail: string }
const OUTCOMES: Outcome[] = ['importado', 'substituído', 'já existia', 'não é holerite', 'erro']

/** Monthly payslips (bulletins de paie): detail + check against the contract amounts. */
export function Payslips({ ctx }: { ctx: Ctx }) {
  const [list, setList] = useState<Payslip[] | null>(null)
  const [sel, setSel] = useState('')
  const [results, setResults] = useState<FileResult[]>([])
  const [progress, setProgress] = useState<string | null>(null)
  const dirRef = useRef<HTMLInputElement>(null)
  // webkitdirectory is not in React's prop types; set it on the element itself.
  useEffect(() => {
    dirRef.current?.setAttribute('webkitdirectory', '')
    dirRef.current?.setAttribute('directory', '')
  }, [])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const saved = ctx.data.settings.payroll_contract
  const [contract, setContract] = useState<ContractItem[]>(saved?.length ? saved : DEFAULT_CONTRACT)
  const [comparing, setComparing] = useState(false)

  const load = useCallback(async () => {
    try {
      const l = await listPayslips()
      setList(l)
      setSel((s) => (s && l.some((p) => p.id === s) ? s : l[0]?.id ?? ''))
      return l
    } catch (e) {
      setError(/payslips/.test((e as Error).message)
        ? 'Tabela de holerites não encontrada: rode supabase/migrations/002_payslips.sql no SQL Editor do Supabase.'
        : (e as Error).message)
    }
  }, [])
  useEffect(() => { load() }, [load])

  /**
   * Imports any number of payslips at once (files or a whole folder). Files that are not
   * PDFs or not bulletins de paie are skipped, not reported as errors. One payslip per
   * month: an identical file is skipped, a different file for the same month replaces it.
   */
  async function onFiles(files: FileList | null) {
    const pdfs = [...(files ?? [])].filter((f) => /\.pdf$/i.test(f.name)).sort((x, y) => x.name.localeCompare(y.name))
    if (!pdfs.length) { setResults([]); setProgress('Nenhum PDF na seleção.'); return }
    setBusy(true); setResults([])
    const out: FileResult[] = []
    const existing = new Map((list ?? []).map((p) => [p.period.slice(0, 7), p.file_sha256]))
    let lastPeriod = ''
    const { loadPdf } = await import('../lib/pdf') // pdf.js is loaded only when importing
    for (const [i, file] of pdfs.entries()) {
      setProgress(`Lendo ${i + 1} de ${pdfs.length}: ${file.name}`)
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const hash = await sha256(bytes)
        const pages = await pdfToRows(bytes, loadPdf)
        if (!looksLikePayslip(pages)) { out.push({ file: file.name, outcome: 'não é holerite', detail: '' }); continue }
        const p = parsePayslipRows(pages)
        const prev = existing.get(p.period)
        if (prev === hash) { out.push({ file: file.name, outcome: 'já existia', detail: p.period }); continue }
        await savePayslip(p, hash)
        existing.set(p.period, hash)
        if (p.period > lastPeriod) lastPeriod = p.period
        out.push({
          file: file.name, outcome: prev ? 'substituído' : 'importado',
          detail: `${p.period}${p.warnings.length ? ` — conferir: ${p.warnings.join('; ')}` : ''}`,
        })
      } catch (e) { out.push({ file: file.name, outcome: 'erro', detail: (e as Error).message }) }
    }
    setResults(out); setProgress(null); setBusy(false)
    const fresh = await load()
    // Show the newest month just imported.
    const newest = lastPeriod && fresh?.find((x) => x.period.startsWith(lastPeriod))
    if (newest) setSel(newest.id)
  }

  const counts = OUTCOMES.map((o) => [o, results.filter((r) => r.outcome === o).length] as const).filter(([, n]) => n > 0)

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
          <label className="inline"><span className="muted">Importar PDFs</span>
            <input type="file" multiple accept=".pdf" onChange={(e) => { onFiles(e.target.files); e.target.value = '' }} disabled={busy} /></label>
          <label className="inline"><span className="muted">Pasta inteira</span>
            <input ref={dirRef} type="file" multiple onChange={(e) => { onFiles(e.target.files); e.target.value = '' }} disabled={busy} /></label>
          <button onClick={() => setComparing((v) => !v)} disabled={list.length < 2}
            title={list.length < 2 ? 'Precisa de dois holerites importados' : undefined}>{comparing ? 'Fechar comparação' : 'Comparar dois meses'}</button>
          {cur && <button onClick={async () => { if (confirm(`Excluir o holerite de ${cur.period.slice(0, 7)}?`)) { await deletePayslip(cur.id); await load() } }}>Excluir</button>}
        </div>
        <p className="muted">Selecione vários PDFs de uma vez, ou a pasta inteira (subpastas incluídas; o que não for holerite é pulado).
          Os PDFs são lidos no navegador e nunca enviados; só valores e rótulos são guardados. Um holerite por mês: reimportar o mesmo mês substitui o anterior.</p>
        {progress && <p className="muted">{progress}</p>}
        {counts.length > 0 && <>
          <p><strong>{results.length} arquivo(s):</strong> {counts.map(([o, n]) => `${n} ${o}`).join(' · ')}</p>
          <details open={results.some((r) => r.outcome === 'erro' || r.detail.includes('conferir'))}>
            <summary className="muted">Detalhe por arquivo</summary>
            {results.map((r) => (
              <p key={r.file} style={{ fontSize: 13, margin: '2px 0' }} className={r.outcome === 'erro' || r.detail.includes('conferir') ? 'warn' : 'muted'}>
                {r.file}: {r.outcome}{r.detail ? ` · ${r.detail}` : ''}</p>
            ))}
          </details>
        </>}
        {!list.length && <p>Nenhum holerite ainda — importe seus bulletins de paie (PDF).</p>}
      </div>

      <PayEvolution ctx={ctx} list={list} />

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

      {comparing && <Comparar list={list} />}

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

const FIELD_PT: Record<LineDiff['field'], string> = {
  gain: 'ganho', deduction: 'desconto', employer: 'empregador', base: 'base', rate: 'taxa',
}

/** Side-by-side diff of two payslips: which totals moved and which lines moved them. */
function Comparar({ list }: { list: Payslip[] }) {
  const [aId, setAId] = useState(() => list[1]?.id ?? '')
  const [bId, setBId] = useState(() => list[0]?.id ?? '')
  const a = list.find((p) => p.id === aId)
  const b = list.find((p) => p.id === bId)
  const diff = useMemo(() => (a && b ? comparePayslips(toCompare(a), toCompare(b)) : null), [a, b])

  if (list.length < 2) return <div className="card"><h3>Comparar dois meses</h3><p className="muted">Importe pelo menos dois holerites para comparar.</p></div>

  const label = (p: Payslip) => monthLabel(p.period.slice(0, 7))
  const sign = (v: number) => `${v > 0 ? '+' : ''}${eur(v)}`
  const cls = (v: number) => (v > 0 ? 'pos' : v < 0 ? 'neg' : 'muted')

  return (
    <div className="card">
      <h3>Comparar dois meses</h3>
      <div className="row">
        <label className="inline">De
          <select value={aId} onChange={(e) => setAId(e.target.value)}>
            {list.map((p) => <option key={p.id} value={p.id}>{label(p)}</option>)}
          </select>
        </label>
        <label className="inline">Para
          <select value={bId} onChange={(e) => setBId(e.target.value)}>
            {list.map((p) => <option key={p.id} value={p.id}>{label(p)}</option>)}
          </select>
        </label>
      </div>

      {!diff || aId === bId ? <p className="muted">Escolha dois meses diferentes.</p> : <>
        {!diff.totals.length && !diff.lines.length && <p className="pos">Os dois holerites são idênticos.</p>}

        {diff.totals.length > 0 && <>
          <h4>Totais</h4>
          <div className="scroll"><table>
            <thead><tr><th>Item</th><th className="num">{label(a!)}</th><th className="num">{label(b!)}</th><th className="num">Diferença</th></tr></thead>
            <tbody>{diff.totals.map((t) => (
              <tr key={t.key} style={t.key === 'gross' || t.key === 'net_paid' ? { fontWeight: 600 } : undefined}>
                <td>{t.label}</td>
                <td className="num">{t.key === 'pas_rate' ? (t.a ?? '—') : f(t.a)}</td>
                <td className="num">{t.key === 'pas_rate' ? (t.b ?? '—') : f(t.b)}</td>
                <td className={`num ${cls(t.diff)}`}>{t.key === 'pas_rate' ? `${t.diff > 0 ? '+' : ''}${t.diff.toFixed(2)}` : sign(t.diff)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </>}

        {diff.lines.length > 0 && <>
          <h4>Linhas que mudaram ({diff.lines.length})</h4>
          <p className="muted" style={{ fontSize: 12 }}>
            Ordenado pelo tamanho da diferença. A soma dos <strong>ganhos</strong> (fora da linha /101, que é o próprio bruto)
            dá <span className={cls(diff.gainDiff)}>{sign(diff.gainDiff)}</span> — é o que explica a variação do bruto.
            “nova” = só aparece no mês da direita; “saiu” = só no da esquerda.
          </p>
          <div className="scroll" style={{ maxHeight: 460, overflowY: 'auto' }}><table>
            <thead><tr><th>Código</th><th>Linha</th><th>Coluna</th><th className="num">{label(a!)}</th><th className="num">{label(b!)}</th><th className="num">Diferença</th></tr></thead>
            <tbody>{diff.lines.map((l, i) => (
              <tr key={`${l.code ?? ''}|${l.label}|${l.field}|${i}`}>
                <td>{l.code ?? ''}</td>
                <td>{l.label}
                  {l.status === 'added' && <span className="pos" style={{ fontSize: 12 }}> · nova</span>}
                  {l.status === 'removed' && <span className="neg" style={{ fontSize: 12 }}> · saiu</span>}
                </td>
                <td className="muted" style={{ fontSize: 12 }}>{FIELD_PT[l.field]}</td>
                <td className="num">{l.field === 'rate' ? l.a || '' : f(l.a)}</td>
                <td className="num">{l.field === 'rate' ? l.b || '' : f(l.b)}</td>
                <td className={`num ${cls(l.diff)}`}>{l.field === 'rate' ? l.diff.toFixed(2) : sign(l.diff)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </>}
        <ExplicarIA
          signature={`${aId}|${bId}`}
          build={() => payslipPrompt(label(a!), label(b!), diff.totals, diff.lines, diff.gainDiff)}
          note="Texto escrito por um modelo local a partir dos números da tabela acima. Os valores vêm do holerite; a leitura é do modelo e pode estar errada — a tabela é a fonte." />
      </>}
    </div>
  )
}

/** The stored row reshaped into what comparePayslips expects. */
function toCompare(p: Payslip) {
  return {
    totals: {
      gross: p.gross, employee_contrib: p.employee_contrib, employer_contrib: p.employer_contrib,
      employer_cost: p.employer_cost, net_social: p.net_social, net_before_tax: p.net_before_tax,
      net_taxable: p.net_taxable, pas_rate: p.pas_rate, pas_amount: p.pas_amount, net_paid: p.net_paid,
    },
    lines: p.lines,
  }
}

const PAY_COUNTRIES = Object.keys(DEFAULT_INFLATION) as (keyof typeof DEFAULT_INFLATION)[]
const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`

/**
 * Last 24 months of pay: gross and net paid month by month, the peak, and the net needed
 * to keep the purchasing power of the first months, using the inflation of the country
 * the salary is paid in. Country and the inflation table are saved with the user's settings.
 */
function PayEvolution({ ctx, list }: { ctx: Ctx; list: Payslip[] }) {
  const prefs = ctx.data.settings.dashboard?.payroll ?? {}
  const [country, setCountry] = useState<keyof typeof DEFAULT_INFLATION>((prefs.country as keyof typeof DEFAULT_INFLATION) ?? 'França')
  const [tables, setTables] = useState<Record<string, InflationTable>>(() => ({ ...DEFAULT_INFLATION, ...(prefs.inflation ?? {}) }))
  const [editing, setEditing] = useState(false)
  const table = tables[country] ?? DEFAULT_INFLATION[country]

  const months = useMemo(() => new Set(monthWindow(today().slice(0, 7), 24)), [])
  const points = useMemo(() => list.map((p) => ({ month: p.period.slice(0, 7), gross: p.gross, net: p.net_paid }))
    .filter((p) => months.has(p.month)).sort((a, b) => a.month.localeCompare(b.month)), [list, months])
  const r = useMemo(() => payVsInflation(points, table), [points, table])

  async function save(next: { country?: string; inflation?: Record<string, InflationTable> }) {
    const payroll = { country, inflation: tables, ...next }
    await saveSettings({ dashboard: { ...ctx.data.settings.dashboard, payroll } })
  }

  const [buscando, setBuscando] = useState(false)
  const [fonte, setFonte] = useState<string | null>(null)
  const [erroFonte, setErroFonte] = useState<string | null>(null)

  /**
   * Replaces the stored rates with the official ones, keeping the user's own figures for
   * the years Eurostat has not published yet (those stay estimates and stay editable).
   */
  async function buscarOficial() {
    const geo = HICP_GEO[country]
    if (!geo) return
    setBuscando(true); setFonte(null); setErroFonte(null)
    try {
      const res = await fetch(hicpUrl(geo), { headers: { Accept: 'application/json' } })
      if (!res.ok) throw new Error(`O Eurostat respondeu ${res.status}.`)
      const parsed = parseHicp(await res.json())
      const next = { ...tables, [country]: mergeOfficial(table, parsed.rates) }
      setTables(next); save({ inflation: next })
      const anos = Object.keys(parsed.rates).sort()
      setFonte(`Eurostat (HICP, variação média anual): ${anos.length} ano(s) atualizados, ${anos[0]}–${anos.at(-1)}`
        + `${parsed.updated ? `, publicado em ${parsed.updated.slice(0, 10)}` : ''}.`
        + ` Anos depois de ${parsed.lastYear} continuam estimativa sua.`)
    } catch (e) {
      setErroFonte(`Não foi possível buscar no Eurostat: ${(e as Error).message} Os números atuais continuam valendo.`)
    } finally { setBuscando(false) }
  }

  if (!r) return <div className="card"><h3>Evolução do salário</h3><p className="muted">Importe pelo menos dois holerites dos últimos 24 meses para ver a evolução.</p></div>

  const rows = r.rows.map((x) => ({ label: monthLabel(x.month), month: x.month, bruto: x.gross, liquido: x.net, corrigido: Math.round(x.corrected) }))
  const peak = rows.find((x) => x.month === r.peak.month)!
  const years = Object.keys(table).sort()

  return (
    <div className="card">
      <h3>Evolução do salário — últimos 24 meses</h3>
      <div className="row">
        <label className="inline">Recebo em
          <select value={country} onChange={(e) => { const c = e.target.value as keyof typeof DEFAULT_INFLATION; setCountry(c); save({ country: c }) }}>
            {PAY_COUNTRIES.map((c) => <option key={c}>{c}</option>)}
          </select></label>
        <button onClick={() => setEditing(!editing)}>{editing ? 'Fechar inflação' : 'Ver/editar inflação'}</button>
      </div>
      <div className="row">
        <button onClick={buscarOficial} disabled={buscando || !HICP_GEO[country]}
          title={HICP_GEO[country] ? 'Eurostat: HICP, variação média anual' : 'O Eurostat não publica o IPCA do Brasil'}>
          {buscando ? 'Buscando…' : 'Buscar inflação oficial'}
        </button>
        {!HICP_GEO[country] && <span className="muted" style={{ fontSize: 12 }}>
          Busca automática só para França e Portugal (Eurostat). Para o Brasil, informe o IPCA do IBGE em "Ver/editar inflação".
        </span>}
      </div>
      {fonte && <p className="pos" style={{ fontSize: 13 }}>{fonte}</p>}
      {erroFonte && <p className="err" style={{ fontSize: 13 }}>{erroFonte}</p>}

      {editing && (
        <div className="row">
          {years.map((y) => (
            <label key={y} className="inline">{y}{Number(y) >= ESTIMATED_FROM ? '*' : ''}
              <input type="number" step="0.1" style={{ width: 70 }} defaultValue={table[y]}
                onBlur={(e) => {
                  const v = Number(e.target.value)
                  if (!Number.isFinite(v) || v === table[y]) return
                  const next = { ...tables, [country]: { ...table, [y]: v } }
                  setTables(next); save({ inflation: next })
                }} />%</label>
          ))}
          <span className="muted" style={{ fontSize: 12 }}>Inflação anual de {country}. * estimativa: confira e ajuste quando sair o número oficial.</span>
        </div>
      )}
      <div className="kpis">
        <div className="kpi"><div className="l">Pico do líquido</div><div className="v">{f(r.peak.net)}</div><div className="l">{monthLabel(r.peak.month)}</div></div>
        <div className="kpi"><div className="l">Líquido médio: 3 primeiros → 3 últimos</div><div className="v">{f(r.base)} → {f(r.recent)}</div><div className="l">{pct(r.nominalChange)} nominal</div></div>
        <div className="kpi"><div className="l">Inflação no período ({country})</div><div className="v">{pct(r.inflation)}</div></div>
        <div className="kpi"><div className="l">Ganho/perda real</div><div className={`v ${r.realChange < 0 ? 'neg' : 'pos'}`}>{pct(r.realChange)}</div>
          <div className="l">{r.monthlyGap < 0 ? `perde ${f(-r.monthlyGap)}/mês de poder de compra` : `ganha ${f(r.monthlyGap)}/mês acima da inflação`}</div></div>
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={rows}>
          <CartesianGrid {...grid} /><XAxis dataKey="label" {...axis} /><YAxis {...axis} tickFormatter={compact} width={48} />
          <Tooltip {...tooltipStyle} formatter={(v) => f(Number(v))} /><Legend />
          <Line dataKey="bruto" name="Bruto" stroke={SERIES[0]} strokeWidth={2} dot={{ r: 3 }} />
          <Line dataKey="liquido" name="Líquido pago" stroke={SERIES[1]} strokeWidth={2} dot={{ r: 3 }} />
          <Line dataKey="corrigido" name="Líquido inicial + inflação" stroke={SERIES[2]} strokeWidth={2} strokeDasharray="5 4" dot={false} />
          <ReferenceDot x={peak.label} y={peak.liquido ?? 0} r={6} fill={SERIES[1]} stroke="var(--card)" strokeWidth={2}
            label={{ value: 'pico', position: 'top', fill: 'var(--text)', fontSize: 12 }} />
        </LineChart>
      </ResponsiveContainer>
      <ExplicarIA label="Explicar com a IA local"
        signature={`${country}|${r.rows[0]?.month ?? ''}|${r.rows.at(-1)?.month ?? ''}|${Math.round(r.recent)}`}
        build={() => inflationPrompt({
          pais: country,
          moeda: 'EUR',
          de: r.rows[0]?.month ?? '',
          ate: r.rows.at(-1)?.month ?? '',
          liquidoBase: r.base,
          liquidoRecente: r.recent,
          variacaoNominal: r.nominalChange,
          inflacao: r.inflation,
          variacaoReal: r.realChange,
          lacunaMensal: r.monthlyGap,
          picoValor: r.peak.net,
          picoMes: r.peak.month,
          anosEstimados: Object.keys(table).map(Number).filter((y) => y >= ESTIMATED_FROM),
        })} />
      <p className="muted" style={{ fontSize: 12 }}>
        A linha tracejada é o líquido médio dos 3 primeiros holerites corrigido pela inflação de {country}: o que seria preciso receber para manter o poder de compra.
        Meses com bônus ou prêmio aparecem como picos; a comparação usa a média de 3 meses para não depender de um mês isolado.
      </p>
    </div>
  )
}
