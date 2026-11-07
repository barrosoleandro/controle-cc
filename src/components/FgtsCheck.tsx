import { useEffect, useMemo, useState } from 'react'
import type { Ctx } from '../App'
import { listPayslips, type Payslip } from '../lib/payroll'
import { money, monthLabel } from '../lib/format'
import { checkFgts, compLabel, depositsByMonth, FGTS_RATE, parseFgtsExtract } from '../domain/fgts'
import { pdfToLines } from '../parsers/pdfText'
import { Help } from './Page'

/**
 * Confere os depósitos do FGTS contra os holerites da França: 8% do bruto de cada mês em reais
 * (expatriado com CLT ativa, Lei 7.064/82). Os depósitos vêm do extrato do app FGTS, em PDF, e
 * podem ser corrigidos mês a mês; ficam guardados na conta (dashboard.fgtsDeposits).
 */
export function FgtsCheck({ ctx }: { ctx: Ctx }) {
  const brl = money('BRL', 2)
  const eur = money('EUR', 2)
  const [payslips, setPayslips] = useState<Payslip[] | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { listPayslips().then(setPayslips, (e: Error) => setErro(e.message)) }, [])

  const deposits = useMemo(() => ctx.data.settings.dashboard?.fgtsDeposits ?? {}, [ctx.data.settings.dashboard?.fgtsDeposits])
  const check = useMemo(() => checkFgts(payslips ?? [], deposits, (d) => ctx.fx.eurBrl(d)), [payslips, deposits, ctx.fx])

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
      <h3>Conferir o FGTS pelos holerites da França</h3>
      <div className="row">
        <label className="inline"><span className="muted">Extrato do app FGTS (PDF)</span>
          <input type="file" accept="application/pdf" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) void importar(f); e.target.value = '' }} /></label>
        {busy && <span className="muted">Lendo…</span>}
        {msg && <span className="pos">✔ {msg}</span>}
        {erro && <span className="err">{erro}</span>}
      </div>
      {payslips === null && !erro && <p className="muted">Carregando os holerites…</p>}
      {payslips && !check.rows.length && <p className="muted">Nenhum holerite com bruto: importe os bulletins de paie em Holerites.</p>}
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
          <thead><tr><th>Competência</th><th className="num">Bruto (€)</th><th className="num hide-sm">Taxa</th><th className="num">Base (R$)</th>
            <th className="num">Esperado</th><th className="num">Depositado</th><th className="num">Diferença</th><th className="num hide-sm" title="Depositado ÷ 8%: a remuneração sobre a qual a empresa recolheu">Base usada</th></tr></thead>
          <tbody>{check.rows.map((r) => (
            <tr key={r.competencia}>
              <td>{monthLabel(r.competencia)}</td>
              <td className="num">{eur(r.brutoEur)}</td>
              <td className="num muted hide-sm" title={`EUR→BRL de ${r.dataTaxa.split('-').reverse().join('/')}`}>{r.taxa.toFixed(4)}</td>
              <td className="num">{brl(r.baseBrl)}</td>
              <td className="num">{brl(r.esperado)}</td>
              <td className="num"><input type="number" min={0} step="any" style={{ width: 120, textAlign: 'right' }} aria-label={`Depósito de ${compLabel(r.competencia)}`}
                defaultValue={r.depositado ?? ''} key={`${r.competencia}/${r.depositado}`}
                onBlur={(e) => { if (e.target.value !== String(r.depositado ?? '')) setDeposit(r.competencia, e.target.value) }} /></td>
              <td className={`num ${r.diferenca === null ? 'muted' : r.diferenca < -1 ? 'neg' : 'pos'}`}>{r.diferenca === null ? 'sem depósito' : brl(r.diferenca)}</td>
              <td className="num muted hide-sm">{r.baseImplicita === null ? '·' : brl(r.baseImplicita)}</td>
            </tr>
          ))}</tbody>
        </table></div>
        {check.outros.length > 0 && <p className="muted" style={{ fontSize: 13 }}>Depósitos de competências sem holerite francês (fora da conferência): {check.outros.map((o) => `${compLabel(o.competencia)} ${brl(o.valor)}`).join(' · ')}</p>}
      </>}
      <Help title="Como a conferência é feita">
        <p>Para quem foi transferido com o contrato CLT ativo (Lei 7.064/82, art. 3º, parágrafo único), o FGTS incide sobre a remuneração total, inclusive a paga no exterior.
          Esperado = {FGTS_RATE * 100}% do bruto do holerite francês, convertido pela cotação EUR→BRL do BCE no dia do pagamento (sem data, no último dia do mês).
          A empresa pode usar outra cotação (ex.: PTAX), então diferenças de poucos por cento são normais.</p>
        <p><strong>Base usada</strong> = depositado ÷ 8%: se ela fica parecida todo mês e bem abaixo da base em reais, a empresa provavelmente recolhe só sobre um salário de referência no Brasil, e não sobre a remuneração total.</p>
        <p>O depósito de cada competência vence até o dia 20 do mês seguinte. Os valores lidos do extrato podem ser corrigidos na própria tabela; apagar o valor tira o depósito.
          Isto é uma conferência, não um parecer: para cobrar a diferença, leve a tabela ao RH ou a um advogado trabalhista.</p>
      </Help>
    </div>
  )
}
