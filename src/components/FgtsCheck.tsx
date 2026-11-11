import { useEffect, useMemo, useState } from 'react'
import type { Ctx } from '../App'
import { listPayslips, type Payslip } from '../lib/payroll'
import { money, monthLabel } from '../lib/format'
import { checkFgts, compLabel, depositsByMonth, FGTS_RATE, parseFgtsExtract } from '../domain/fgts'
import { fetchToBrl, FxTable } from '../domain/fx'
import { pdfToLines } from '../parsers/pdfText'
import { Help } from './Page'

/**
 * Confere os depósitos do FGTS contra os holerites da França (€) e dos EUA (US$): 8% do bruto de
 * cada mês em reais (expatriado com CLT ativa, Lei 7.064/82). Os depósitos vêm do extrato do app
 * FGTS, em PDF, e podem ser corrigidos mês a mês; ficam guardados na conta (dashboard.fgtsDeposits).
 * A cotação USD→BRL é buscada só quando há holerite em dólar (BCE via Frankfurter).
 */
export function FgtsCheck({ ctx }: { ctx: Ctx }) {
  const brl = money('BRL', 2)
  const eur = money('EUR', 2)
  const [payslips, setPayslips] = useState<Payslip[] | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [usdFx, setUsdFx] = useState<FxTable | null>(null)
  const [erroUsd, setErroUsd] = useState<string | null>(null)
  useEffect(() => { listPayslips().then(setPayslips, (e: Error) => setErro(e.message)) }, [])
  useEffect(() => {
    const dates = (payslips ?? []).filter((p) => p.currency === 'USD').flatMap((p) => p.lines.map((l) => l.payDate ?? '')).filter(Boolean).sort()
    if (!dates.length) return
    // A week of margin before the first payment: the rate of a weekend or holiday is the last business day's.
    const from = new Date(Date.parse(dates[0]) - 7 * 864e5).toISOString().slice(0, 10)
    fetchToBrl('USD', from, dates.at(-1)!).then((m) => setUsdFx(new FxTable(m)), (e: Error) => setErroUsd(`Sem a cotação USD→BRL (${e.message}): os meses em dólar ficam sem base.`))
  }, [payslips])

  const deposits = useMemo(() => ctx.data.settings.dashboard?.fgtsDeposits ?? {}, [ctx.data.settings.dashboard?.fgtsDeposits])
  const check = useMemo(() => checkFgts(payslips ?? [], deposits, (cur, d) => (cur === 'EUR' ? ctx.fx.eurBrl(d) : usdFx ? usdFx.eurBrl(d) : null)), [payslips, deposits, ctx.fx, usdFx])
  const temUsd = check.rows.some((r) => r.bruto.USD)
  const usd = money('USD', 2)

  async function save(next: Record<string, number>) {
    setErro(null)
    try { await ctx.patchSettings({ dashboard: { ...ctx.data.settings.dashboard, fgtsDeposits: next } }); return true } catch (e) { setErro((e as Error).message); return false }
  }
  async function importar(file: File) {
    setBusy(true); setErro(null); setMsg(null)
    try {
      const { loadPdf } = await import('../lib/pdf')
      const found = parseFgtsExtract(await pdfToLines(new Uint8Array(await file.arrayBuffer()), loadPdf))
      if (!found.length) { setErro('Não encontrei depósitos neste PDF. É o extrato do app FGTS (Extrato completo)? Se for, digite os valores na tabela e me mande o formato.'); return }
      const byMonth = depositsByMonth(found)
      if (await save({ ...deposits, ...byMonth })) {
        const inferidas = found.filter((d) => d.inferida).length
        setMsg(`${found.length} depósito(s) lidos, em ${Object.keys(byMonth).length} competência(s)${inferidas ? `; ${inferidas} sem competência no texto, atribuídos ao mês anterior ao lançamento` : ''}. Confira na tabela.`)
      }
    } catch (e) { setErro((e as Error).message) } finally { setBusy(false) }
  }
  const setDeposit = (c: string, v: string) => {
    const next = { ...deposits }
    if (v.trim() === '') delete next[c]; else next[c] = Number(v) || 0
    void save(next)
  }

  const comDep = check.rows.filter((r) => r.depositado !== null)
  const pct = comDep.length ? comDep.reduce((s, r) => s + r.depositado!, 0) / comDep.reduce((s, r) => s + r.esperado, 0) : null

  return (
    <div className="card" style={{ gridColumn: '1/-1' }}>
      <h3>Conferir o FGTS pelos holerites (França e EUA)</h3>
      <div className="row">
        <label className="inline"><span className="muted">Extrato do app FGTS (PDF)</span>
          <input type="file" accept="application/pdf" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) void importar(f); e.target.value = '' }} /></label>
        {busy && <span className="muted">Lendo…</span>}
        {msg && <span className="pos">✔ {msg}</span>}
        {erro && <span className="err">{erro}</span>}
        {erroUsd && <span className="err">{erroUsd}</span>}
      </div>
      {payslips === null && !erro && <p className="muted">Carregando os holerites…</p>}
      {payslips && !check.rows.length && <p className="muted">Nenhum holerite com bruto: importe os bulletins de paie ou os Pay Statements dos EUA em Holerites.</p>}
      {check.rows.length > 0 && <>
        <div className="kpis" style={{ marginTop: 12 }}>
          <div className="kpi"><div className="l">Esperado (8% do bruto)</div><div className="v">{brl(check.esperado)}</div>
            <div className="sub">{check.rows.length} holerite(s), {compLabel(check.rows[0].competencia)} a {compLabel(check.rows.at(-1)!.competencia)}</div></div>
          <div className="kpi"><div className="l">Depositado</div><div className="v">{brl(check.depositado)}</div>
            <div className="sub">{pct === null ? 'importe o extrato' : `${Math.round(pct * 100)}% do esperado nos meses com depósito`}</div></div>
          <div className={`kpi ${check.diferenca < -1 ? 'total' : ''}`}><div className="l">Diferença</div>
            <div className={`v ${check.diferenca < -1 ? 'neg' : 'pos'}`}>{brl(check.diferenca)}</div>
            <div className="sub">{check.semDeposito.length ? `${check.semDeposito.length} mês(es) sem depósito` : 'todos os meses com depósito'}</div></div>
        </div>
        <div className="scroll"><table>
          <thead><tr><th>Competência</th><th className="num">Bruto</th><th className="num hide-sm">Taxa</th><th className="num">Base (R$)</th>
            <th className="num">Esperado</th><th className="num">Depositado</th><th className="num">Diferença</th><th className="num hide-sm" title="Depositado ÷ 8%: a remuneração sobre a qual a empresa recolheu">Base usada</th></tr></thead>
          <tbody>{check.rows.map((r) => (
            <tr key={r.competencia}>
              <td>{monthLabel(r.competencia)}</td>
              <td className="num">{[r.bruto.EUR !== undefined && eur(r.bruto.EUR), r.bruto.USD !== undefined && usd(r.bruto.USD)].filter(Boolean).join(' + ')}
                {r.foraDaBase > 0 && <div className="muted" style={{ fontSize: 11 }} title="Ganhos sem dinheiro nos contracheques dos EUA (Share Vesting, Fringe, Auto Allowance…): fora da base">fora: {usd(r.foraDaBase)}</div>}</td>
              <td className="num muted hide-sm" title={r.bruto.USD && !r.bruto.EUR ? `USD→BRL do dia de cada pagamento (média ponderada); último em ${r.dataTaxa.split('-').reverse().join('/')}` : `EUR→BRL de ${r.dataTaxa.split('-').reverse().join('/')}`}>
                {r.semTaxa ? 'sem cotação' : r.taxa === null ? 'várias' : r.taxa.toFixed(4)}</td>
              <td className={`num ${r.semTaxa ? 'warn' : ''}`}>{brl(r.baseBrl)}</td>
              <td className="num">{brl(r.esperado)}</td>
              <td className="num"><input type="number" min={0} step="any" style={{ width: 120, textAlign: 'right' }} aria-label={`Depósito de ${compLabel(r.competencia)}`}
                defaultValue={r.depositado ?? ''} key={`${r.competencia}/${r.depositado}`}
                onBlur={(e) => { if (e.target.value !== String(r.depositado ?? '')) setDeposit(r.competencia, e.target.value) }} /></td>
              <td className={`num ${r.diferenca === null ? 'muted' : r.diferenca < -1 ? 'neg' : 'pos'}`}>{r.diferenca === null ? 'sem depósito' : brl(r.diferenca)}</td>
              <td className="num muted hide-sm">{r.baseImplicita === null ? '·' : brl(r.baseImplicita)}</td>
            </tr>
          ))}</tbody>
        </table></div>
        {check.outros.length > 0 && <p className="muted" style={{ fontSize: 13 }}>Depósitos de competências sem holerite (fora da conferência): {check.outros.map((o) => `${compLabel(o.competencia)} ${brl(o.valor)}`).join(' · ')}</p>}
      </>}
      <Help title="Como a conferência é feita">
        <p>Para quem foi transferido com o contrato CLT ativo (Lei 7.064/82, art. 3º, parágrafo único), o FGTS incide sobre a remuneração total, inclusive a paga no exterior.
          Esperado = {FGTS_RATE * 100}% do bruto do mês, convertido pela cotação do BCE no dia do pagamento: EUR→BRL para o holerite francês (sem data, no último dia do mês),
          USD→BRL para cada contracheque quinzenal dos EUA, somados no mês em que foram pagos. Num mês com os dois (o da transferência), as duas partes se somam.
          A empresa pode usar outra cotação (ex.: PTAX), então diferenças de poucos por cento são normais.</p>
        {temUsd && <p>Nos EUA entra na base o que foi pago em dinheiro: Regular Pay, Holiday, Vacation, bônus (VBP Bonus, Bonus) e Retro Pay.
          Ficam de fora, na linha “fora”, os ganhos sem dinheiro: Share Vesting (ações, que a Justiça do Trabalho costuma tratar como não salariais), Fringe anual e itens
          que o próprio contracheque desconta de volta (Auto Allowance, Gift / Prize). O auxílio-moradia (Housing Allow, desconto negativo) também não está na base.
          Se o seu entendimento for outro, a coluna Base usada mostra sobre quanto a empresa recolheu.</p>}
        <p><strong>Base usada</strong> = depositado ÷ 8%: se ela fica parecida todo mês e bem abaixo da base em reais, a empresa provavelmente recolhe só sobre um salário de referência no Brasil, e não sobre a remuneração total.</p>
        <p>O depósito de cada competência vence até o dia 20 do mês seguinte. Os valores lidos do extrato podem ser corrigidos na própria tabela; apagar o valor tira o depósito.
          Isto é uma conferência, não um parecer: para cobrar a diferença, leve a tabela ao RH ou a um advogado trabalhista.</p>
      </Help>
    </div>
  )
}
