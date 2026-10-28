import { useState } from 'react'
import type { Ctx } from '../App'
import { ALIQUOTAS_REGRESSIVAS, AVISOS, TIPOS, calcularRescisao, novaPrevidencia, type Previdencia, isRescisao, novaRescisao, type Aviso, type RescisaoInput, type TipoRescisao } from '../domain/rescisao'
import { deleteScenario, saveScenario } from '../lib/data'
import { money } from '../lib/format'
import { Help } from '../components/Page'

/**
 * Estimativa da rescisão CLT no Brasil. Cada simulação é guardada com nome na tabela de
 * cenários (marcada com kind 'rescisao'), para voltar a ela e comparar.
 */
export function Rescisao({ ctx }: { ctx: Ctx }) {
  const brl = money('BRL', 2)
  const eur = money('EUR', 0)
  const rate = ctx.fx.latest()
  const saved = ctx.data.scenarios.filter((s) => isRescisao(s.data)).map((s) => ({ id: s.id, s: s.data as RescisaoInput }))
  const [editingId, setEditingId] = useState<string | null>(saved[0]?.id ?? null)
  const [s, setS] = useState<RescisaoInput>(() => saved[0]?.s ?? novaRescisao())
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const set = <K extends keyof RescisaoInput>(k: K, v: RescisaoInput[K]) => { setS((x) => ({ ...x, [k]: v })); setMsg(null) }
  const num = (k: 'salario' | 'adicionais' | 'feriasVencidas' | 'adiantamento13' | 'saldoFgts' | 'baseMultaFgts' | 'dependentes' | 'outrosDescontos', step = 100) => ({
    type: 'number', min: 0, step, value: s[k] ?? 0, onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(k, Number(e.target.value) || 0),
  })
  const p = { ...novaPrevidencia(), ...s.previdencia }
  const setP = (patch: Partial<Previdencia>) => set('previdencia', { ...p, ...patch })
  const numP = (k: 'suas' | 'empresa' | 'vestingPct' | 'aportado', step = 1000) => ({
    type: 'number', min: 0, step, value: p[k], onChange: (e: React.ChangeEvent<HTMLInputElement>) => setP({ [k]: Number(e.target.value) || 0 }),
  })
  const avisos = TIPOS[s.tipo].avisos
  const pronto = Boolean(s.admissao && s.desligamento && s.admissao <= s.desligamento && s.salario > 0)
  const r = pronto ? calcularRescisao(s) : null

  async function salvar(novo: boolean) {
    setBusy(true)
    try {
      setEditingId(await saveScenario(novo ? null : editingId, s.name, s))
      await ctx.reload()
      setMsg('Simulação salva.')
    } catch (e) { setMsg(`Não foi possível salvar: ${(e as Error).message}`) }
    setBusy(false)
  }

  const linha = (label: string, valor: number, nota?: string, cls = '') => (
    <tr key={label}><td>{label}{nota && <span className="muted" style={{ fontSize: 12 }}> · {nota}</span>}</td>
      <td className={`num ${cls}`}>{brl(valor)}</td><td className="num muted hide-sm">{eur(valor / rate)}</td></tr>
  )

  return <div className="grid">
    <div className="card" style={{ gridColumn: '1/-1' }}>
      <div className="row" style={{ marginBottom: 12 }}>
        <label className="inline"><span className="muted">Simulação</span>
          <select value={editingId ?? ''} onChange={(e) => {
            const x = saved.find((y) => y.id === e.target.value)
            setEditingId(x?.id ?? null); setS(x ? { ...novaRescisao(), ...x.s } : novaRescisao()); setMsg(null)
          }}>
            <option value="">(nova)</option>{saved.map((x) => <option key={x.id} value={x.id}>{x.s.name}</option>)}
          </select></label>
      </div>
      <div className="form">
        <label>Nome<input value={s.name} onChange={(e) => set('name', e.target.value)} /></label>
        <label>Tipo de desligamento<select value={s.tipo} onChange={(e) => {
          const t = e.target.value as TipoRescisao
          setS((x) => ({ ...x, tipo: t, aviso: TIPOS[t].avisos.includes(x.aviso) ? x.aviso : TIPOS[t].avisos[0] ?? x.aviso })); setMsg(null)
        }}>{(Object.keys(TIPOS) as TipoRescisao[]).map((t) => <option key={t} value={t}>{TIPOS[t].label}</option>)}</select></label>
        {avisos.length > 0 && <label>Aviso prévio<select value={s.aviso} onChange={(e) => set('aviso', e.target.value as Aviso)}>
          {avisos.map((a) => <option key={a} value={a}>{AVISOS[a]}</option>)}</select></label>}
        <label>Data de admissão<input type="date" value={s.admissao} onChange={(e) => set('admissao', e.target.value)} /></label>
        <label>Último dia trabalhado<input type="date" value={s.desligamento} onChange={(e) => set('desligamento', e.target.value)} /></label>
        <label>Salário bruto mensal (R$)<input {...num('salario')} /></label>
        <label>Médias de adicionais / mês (R$)<input {...num('adicionais')} /></label>
        <label>Férias vencidas não gozadas (períodos)<input {...num('feriasVencidas', 1)} /></label>
        <label>1ª parcela do 13º já paga (R$)<input {...num('adiantamento13')} /></label>
        <label>Saldo atual do FGTS deste contrato (R$)<input {...num('saldoFgts', 1000)} /></label>
        <label>Saldo para fins rescisórios (R$)<input {...num('baseMultaFgts', 1000)} title="No extrato do FGTS (app FGTS). Base da multa: soma dos depósitos com correção, sem descontar saques. Em branco ou zero, usa o saldo atual." /></label>
        <label className="inline" style={{ alignSelf: 'end' }}><input type="checkbox" checked={!!s.saqueAniversario} onChange={(e) => set('saqueAniversario', e.target.checked)} />Optei pelo saque-aniversário</label>
        <label>Dependentes para o IR<input {...num('dependentes', 1)} /></label>
        <label>Outros descontos (R$)<input {...num('outrosDescontos')} /></label>
      </div>
      <h4>Previdência privada</h4>
      <div className="form">
        <label>Saldo das suas contribuições (R$)<input {...numP('suas')} /></label>
        <label>Saldo das contribuições da empresa (R$)<input {...numP('empresa')} /></label>
        <label>% da parte da empresa que você leva<input {...numP('vestingPct', 5)} max={100} title="Regra de resgate (vesting) do plano: costuma crescer com o tempo de empresa" /></label>
        <label>Plano<select value={p.plano} onChange={(e) => setP({ plano: e.target.value as Previdencia['plano'] })}>
          <option value="PGBL">PGBL (IR sobre tudo)</option><option value="VGBL">VGBL (IR só sobre o rendimento)</option></select></label>
        {p.plano === 'VGBL' && <label>Total aportado na parte resgatada (R$)<input {...numP('aportado')} /></label>}
        <label>Tributação<select value={p.regime === 'progressivo' ? 'progressivo' : String(p.aliquota)} onChange={(e) => setP(e.target.value === 'progressivo' ? { regime: 'progressivo' } : { regime: 'regressivo', aliquota: Number(e.target.value) })}>
          <option value="progressivo">Progressiva (15% na fonte, ajuste na declaração)</option>
          {ALIQUOTAS_REGRESSIVAS.map(([a, l]) => <option key={a} value={a}>Regressiva {a * 100}% ({l})</option>)}</select></label>
        <label className="inline" style={{ alignSelf: 'end' }}><input type="checkbox" checked={p.resgatar} onChange={(e) => setP({ resgatar: e.target.checked })} />Resgatar ao sair (senão, portar ou manter)</label>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" disabled={busy} onClick={() => salvar(!editingId)}>{editingId ? 'Salvar' : 'Salvar como nova'}</button>
        {editingId && <button disabled={busy} onClick={() => salvar(true)}>Salvar como nova</button>}
        {editingId && <button disabled={busy} onClick={async () => {
          if (!confirm(`Excluir a simulação “${s.name}”?`)) return
          await deleteScenario(editingId); setEditingId(null); setS(novaRescisao()); await ctx.reload()
        }}>Excluir</button>}
        {msg && <span className="muted">{msg}</span>}
      </div>
    </div>

    {!r && <div className="card" style={{ gridColumn: '1/-1' }}><p className="muted">Preencha a admissão, o último dia trabalhado e o salário para ver o cálculo.</p></div>}

    {r && <>
      <div className="card" style={{ gridColumn: '1/-1' }}>
        <div className="kpis">
          <div className="kpi total"><div className="l">Total a receber</div><div className="v pos">{brl(r.total)}</div><div className="sub">≈ {eur(r.total / rate)}</div></div>
          <div className="kpi"><div className="l">Líquido da rescisão</div><div className="v">{brl(r.liquido)}</div><div className="sub">≈ {eur(r.liquido / rate)}</div></div>
          {r.previdencia?.resgatar && <div className="kpi"><div className="l">Previdência (líquido)</div><div className="v">{brl(r.previdencia.liquido)}</div><div className="sub">≈ {eur(r.previdencia.liquido / rate)}</div></div>}
          <div className="kpi"><div className="l">FGTS para sacar</div><div className="v">{brl(r.fgts.sacavel)}</div>
            <div className="sub">{r.fgts.ficaNaConta > 0 ? `${brl(r.fgts.ficaNaConta)} ficam na conta` : `≈ ${eur(r.fgts.sacavel / rate)}`}</div></div>
          <div className="kpi"><div className="l">Fim do contrato</div><div className="v">{r.fimProjetado.split('-').reverse().join('/')}</div>
            <div className="sub">{r.diasAvisoPagos ? `com ${r.diasAvisoPagos} dias de aviso projetados` : 'sem projeção de aviso'}</div></div>
        </div>
      </div>

      <div className="card">
        <h3>Termo de rescisão</h3>
        <div className="scroll"><table>
          <thead><tr><th>Verba</th><th className="num">R$</th><th className="num hide-sm">€</th></tr></thead>
          <tbody>
            {r.verbas.map((v) => linha(v.label, v.valor, v.nota))}
            <tr><th>Total bruto</th><th className="num">{brl(r.bruto)}</th><th className="num hide-sm">{eur(r.bruto / rate)}</th></tr>
            {r.descontos.map((v) => linha(v.label, -v.valor, v.nota, 'neg'))}
          </tbody>
          <tfoot><tr><th>Líquido</th><th className="num">{brl(r.liquido)}</th><th className="num hide-sm">{eur(r.liquido / rate)}</th></tr></tfoot>
        </table></div>
      </div>

      <div className="card">
        <h3>FGTS</h3>
        <div className="scroll"><table>
          <tbody>
            {linha('Saldo atual', r.fgts.saldo)}
            {linha('Depósito da rescisão (8%)', r.fgts.deposito, 'sobre saldo de salário, aviso e 13º')}
            {r.fgts.multaPct > 0 && linha(`Multa de ${r.fgts.multaPct * 100}%`, r.fgts.multa, `sobre ${brl(r.fgts.baseMulta)} (fins rescisórios + depósito) · paga pela empresa, sem IR`)}
            {r.fgts.ficaNaConta > 0 && linha('Fica na conta (não sacável agora)', -r.fgts.ficaNaConta, undefined, 'muted')}
          </tbody>
          <tfoot><tr><th>Para sacar</th><th className="num">{brl(r.fgts.sacavel)}</th><th className="num hide-sm">{eur(r.fgts.sacavel / rate)}</th></tr></tfoot>
        </table></div>
      </div>

      {r.previdencia && <div className="card">
        <h3>Previdência privada</h3>
        <div className="scroll"><table>
          <tbody>
            {linha('Saldo que você leva', r.previdencia.bruto, r.previdencia.perdido > 0 ? `${brl(r.previdencia.perdido)} da empresa ficam no plano` : undefined)}
            {linha(`IR do resgate (${Math.round(r.previdencia.aliquota * 100)}%)`, -r.previdencia.ir, p.regime === 'progressivo' ? 'antecipação; o acerto vem na declaração' : 'definitivo', 'neg')}
          </tbody>
          <tfoot><tr><th>{r.previdencia.resgatar ? 'Líquido do resgate' : 'Fica aplicado (fora do total)'}</th>
            <th className="num">{brl(r.previdencia.liquido)}</th><th className="num hide-sm">{eur(r.previdencia.liquido / rate)}</th></tr></tfoot>
        </table></div>
      </div>}
    </>}

    <div className="card" style={{ gridColumn: '1/-1' }}>
      <Help title="Como o cálculo é feito">
        <p>Estimativa pelas regras gerais da CLT, com as tabelas de INSS e IR de 2026. Convenção coletiva, horas extras não informadas,
          PLR, seguro-desemprego e férias em dobro ficam de fora. Confira com o termo de rescisão da empresa.</p>
        <p>Aviso prévio (Lei 12.506): 30 dias mais 3 por ano completo, até 90. Indenizado, ele conta no tempo de serviço para o 13º e as férias; no acordo, a empresa paga metade.</p>
        <p>13º e férias proporcionais: conta o mês com 15 dias ou mais trabalhados. Na justa causa, só entram o saldo de salário e as férias vencidas.</p>
        <p>Impostos: INSS e IR sobre o saldo de salário e, em separado, sobre o 13º. Férias indenizadas com 1/3, aviso indenizado e multa do FGTS não têm INSS nem IR.
          O IR já considera a isenção até R$ 5.000 por mês da Lei 15.270/2025.</p>
        <p>FGTS: a multa incide sobre o saldo para fins rescisórios (todos os depósitos do contrato com correção, sem descontar saques já feitos), mais o depósito da rescisão.
          Na dispensa sem justa causa, saca o saldo atual mais 40% de multa; no acordo, 80% do saldo mais 20% de multa; no pedido de demissão e na justa causa, o saldo fica na conta.
          Quem optou pelo saque-aniversário recebe só a multa: o saldo fica na conta.</p>
        <p>Previdência privada: você leva o saldo das suas contribuições e, da parte da empresa, o percentual da regra de resgate do plano.
          No PGBL o IR incide sobre todo o resgate; no VGBL, só sobre o rendimento. Na tabela progressiva, a fonte retém 15% e o acerto (até 27,5%) vem na declaração anual;
          na regressiva, a alíquota é definitiva e cai com o tempo de cada aporte. Portar para outro plano não paga IR.</p>
        <p>Os valores em euro usam a cotação mais recente guardada ({rate.toFixed(4)}).</p>
      </Help>
    </div>
  </div>
}
