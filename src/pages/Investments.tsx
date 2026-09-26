import { useMemo, useState } from 'react'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { Ctx } from '../App'
import { ALOCACAO, CLASSE_NOME, VEICULOS, projetar, reservaRecomendada, retornoRealCarteira, type Classe, type Regiao, type Risco, type Veiculo } from '../domain/investments'
import { monthly } from '../domain/analytics'
import { SERIES, axis, compact, grid, tooltipStyle } from '../components/charts'
import { last3, useBalances, useFmt } from '../lib/hooks'

const PERFIS: { id: Risco; nome: string; descricao: string }[] = [
  { id: 'conservador', nome: 'Conservador', descricao: 'Prioriza não perder. Aceita render pouco acima da inflação.' },
  { id: 'moderado', nome: 'Moderado', descricao: 'Aceita oscilação em parte da carteira para render mais no longo prazo.' },
  { id: 'arrojado', nome: 'Arrojado', descricao: 'Maior parte em ações. Pode passar anos no vermelho antes de recuperar.' },
]
const REGIAO_NOME: Record<Regiao, string> = { EU: 'Europa / França', BR: 'Brasil' }

export function Investments({ ctx }: { ctx: Ctx }) {
  const fmt = useFmt(ctx)
  const saldos = useBalances(ctx)
  const [risco, setRisco] = useState<Risco>('moderado')
  const [anos, setAnos] = useState(10)
  const [aporteManual, setAporteManual] = useState<number | null>(null)
  const [retornos, setRetornos] = useState<Record<string, number>>(
    () => Object.fromEntries(VEICULOS.map((v) => [v.id, v.retornoReal])),
  )

  // Base real: média de receitas e despesas dos últimos três meses fechados.
  const base = useMemo(() => {
    const meses = new Set(last3())
    const series = monthly(ctx.etx).filter((m) => meses.has(m.month))
    const n = Math.max(1, series.length)
    const receita = series.reduce((s, m) => s + m.income, 0) / n
    const despesa = series.reduce((s, m) => s + m.expense, 0) / n
    return { receita, despesa, sobra: receita - despesa, meses: series.length }
  }, [ctx.etx])

  const liquido = saldos.reduce((s, b) => s + b.display, 0)
  const reserva = reservaRecomendada(base.despesa)
  const faltaReserva = Math.max(0, reserva - liquido)
  const aporte = aporteManual ?? Math.max(0, Math.round(base.sobra))

  const veiculos = useMemo(
    () => VEICULOS.map((v) => ({ ...v, retornoReal: retornos[v.id] ?? v.retornoReal })),
    [retornos],
  )
  const retornoCarteira = useMemo(() => retornoRealCarteira(risco, veiculos), [risco, veiculos])
  const projecao = useMemo(
    () => projetar(aporte, anos, retornoCarteira, Math.min(liquido, reserva)),
    [aporte, anos, retornoCarteira, liquido, reserva],
  )
  const fim = projecao.at(-1)!

  const porClasse = useMemo(() => {
    const pesos = ALOCACAO[risco]
    return (Object.keys(CLASSE_NOME) as Classe[])
      .map((classe) => ({ classe, peso: pesos[classe], valor: aporte * pesos[classe], veiculos: veiculos.filter((v) => v.classe === classe) }))
      .filter((x) => x.peso > 0)
  }, [risco, aporte, veiculos])

  return (
    <div className="grid">
      <div className="card" style={{ gridColumn: '1/-1' }}>
        <h3>Investimentos — a partir dos seus números</h3>
        <p className="muted">
          Esta tela é material de estudo, não recomendação de investimento. Ela organiza os <strong>tipos</strong> de
          investimento disponíveis no Brasil e na França e projeta cenários com premissas que você mesmo edita.
          Nenhum ativo, corretora ou papel específico é indicado. Antes de decidir, confirme as regras tributárias
          atuais e a sua situação de residência fiscal — morando na França com conta no Brasil, isso muda o resultado.
        </p>
        <div className="kpis">
          <div className="kpi"><div className="l">Receita média (3 meses)</div><div>{fmt(base.receita)}</div></div>
          <div className="kpi"><div className="l">Despesa média</div><div>{fmt(base.despesa)}</div></div>
          <div className="kpi"><div className="l">Sobra por mês</div><div className={base.sobra >= 0 ? 'pos' : 'neg'}>{fmt(base.sobra)}</div></div>
          <div className="kpi"><div className="l">Saldo hoje</div><div>{fmt(liquido)}</div></div>
        </div>
        {base.meses < 3 && <p className="warn">Só {base.meses} mês(es) fechado(s) de dados: a média ainda é frágil. Importe mais extratos para a projeção fazer sentido.</p>}
      </div>

      <div className="card" style={{ gridColumn: '1/-1' }}>
        <h3>Antes de investir: reserva de emergência</h3>
        <p>
          Seis meses da sua despesa média dão <strong>{fmt(reserva)}</strong>.
          {faltaReserva > 0
            ? <> Hoje você tem {fmt(liquido)} disponível, então ainda faltam <strong className="warn">{fmt(faltaReserva)}</strong>. Enquanto isso não fechar, o destino natural da sobra é um lugar líquido e sem risco — Livret A na França, Tesouro Selic no Brasil — e não bolsa.</>
            : <> Você já tem {fmt(liquido)} disponível, o que cobre a reserva. A sobra mensal pode ir para a carteira abaixo.</>}
        </p>
      </div>

      <div className="card" style={{ gridColumn: '1/-1' }}>
        <h3>Perfil e cenário</h3>
        <div className="row">
          {PERFIS.map((p) => (
            <button key={p.id} className={p.id === risco ? 'active' : ''} onClick={() => setRisco(p.id)}>{p.nome}</button>
          ))}
          <label className="inline">Aporte mensal
            <input type="number" step="50" min="0" value={aporte} onChange={(e) => setAporteManual(Number(e.target.value))} />
          </label>
          <label className="inline">Prazo (anos)
            <input type="number" step="1" min="1" max="40" value={anos} onChange={(e) => setAnos(Math.max(1, Math.min(40, Number(e.target.value))))} />
          </label>
          {aporteManual !== null && <button onClick={() => setAporteManual(null)}>Usar a sobra real</button>}
        </div>
        <p className="muted">{PERFIS.find((p) => p.id === risco)!.descricao} Retorno real ponderado da carteira: <strong>{retornoCarteira.toFixed(1)}% ao ano</strong> acima da inflação.</p>

        <div className="kpis">
          <div className="kpi"><div className="l">Aportado em {anos} anos</div><div>{fmt(fim.aportado)}</div></div>
          <div className="kpi"><div className="l">Valor projetado</div><div className="pos">{fmt(fim.valor)}</div></div>
          <div className="kpi"><div className="l">Rendimento</div><div>{fmt(fim.valor - fim.aportado)}</div></div>
        </div>
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={projecao}>
            <CartesianGrid {...grid} />
            <XAxis dataKey="ano" {...axis} tickFormatter={(a) => `${a}a`} />
            <YAxis {...axis} tickFormatter={compact} />
            <Tooltip {...tooltipStyle} formatter={(v) => fmt(Number(v))} labelFormatter={(a) => `Ano ${a}`} />
            <Legend />
            <Line type="monotone" dataKey="aportado" name="Aportado" stroke={SERIES[1]} dot={false} strokeWidth={2} />
            <Line type="monotone" dataKey="valor" name="Projetado" stroke={SERIES[0]} dot={false} strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
        <p className="muted">
          Valores em moeda de hoje: o retorno usado já é real, descontada a inflação. A projeção supõe aporte constante e
          retorno liso, o que nunca acontece — a bolsa entrega esse número como média de décadas, não ano a ano.
        </p>
      </div>

      <div className="card" style={{ gridColumn: '1/-1' }}>
        <h3>Como dividir {fmt(aporte)} por mês — perfil {PERFIS.find((p) => p.id === risco)!.nome.toLowerCase()}</h3>
        <div className="scroll"><table>
          <thead><tr><th>Classe</th><th className="num">Fatia</th><th className="num">Por mês</th><th>Onde isso vive</th></tr></thead>
          <tbody>{porClasse.map((c) => (
            <tr key={c.classe}>
              <td>{CLASSE_NOME[c.classe]}</td>
              <td className="num">{Math.round(c.peso * 100)}%</td>
              <td className="num">{fmt(c.valor)}</td>
              <td className="muted">{c.veiculos.map((v) => v.nome).join(' · ')}</td>
            </tr>
          ))}</tbody>
        </table></div>
        <p className="muted">As fatias são um ponto de partida convencional para cada perfil, não um cálculo otimizado para você.</p>
      </div>

      {(['EU', 'BR'] as Regiao[]).map((regiao) => (
        <div className="card" key={regiao} style={{ gridColumn: '1/-1' }}>
          <h3>{REGIAO_NOME[regiao]}</h3>
          <div className="scroll"><table>
            <thead><tr><th>Tipo</th><th>Classe</th><th>Liquidez</th><th>Risco</th><th className="num">Retorno real</th><th>Tributação (regra geral)</th></tr></thead>
            <tbody>{veiculos.filter((v) => v.regiao === regiao).map((v) => (
              <tr key={v.id}>
                <td><strong>{v.nome}</strong><div className="muted" style={{ fontSize: 12 }}>{v.observacao}</div></td>
                <td>{CLASSE_NOME[v.classe]}</td>
                <td>{v.liquidez}</td>
                <td className={v.risco === 'alto' ? 'neg' : v.risco === 'medio' ? 'warn' : 'pos'}>{v.risco}</td>
                <td className="num"><input type="number" step="0.5" style={{ width: 80 }} value={v.retornoReal}
                  onChange={(e) => setRetornos({ ...retornos, [v.id]: Number(e.target.value) })} aria-label={`Retorno real de ${v.nome}`} />% a.a.</td>
                <td className="muted">{v.tributacao}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </div>
      ))}

      <div className="card" style={{ gridColumn: '1/-1' }}>
        <h3>O que esta tela não faz</h3>
        <ul>
          <li>Não indica ações, fundos, ETFs, corretoras ou papéis específicos.</li>
          <li>Não sabe a sua residência fiscal, seu estado civil nem seus outros bens — tudo isso muda a conta.</li>
          <li>As regras de tributação descritas são o caso geral e mudam com frequência; confirme as atuais.</li>
          <li>Os retornos são premissas editáveis, não previsões. Retorno passado não se repete por decreto.</li>
          <li>Para uma decisão de verdade, vale conversar com um profissional habilitado nos dois países.</li>
        </ul>
      </div>
    </div>
  )
}

export type { Veiculo }
