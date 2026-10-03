import { useCallback, useEffect, useMemo, useState } from 'react'
import Papa from 'papaparse'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { listPayslips, type Payslip } from '../lib/payroll'
import { addEntries, addRole, deleteEntry, deleteRole, listEntries, listRoles, seedRoles, type NewEntry } from '../lib/market'
import { BASIS_LABEL, compareRole, myGrossYear, type BenchmarkEntry, type BenchmarkRole } from '../domain/market'
import { CSV_EXAMPLE, CSV_HEADER, parseBenchmarkRows, type ImportedEntry } from '../domain/marketImport'
import { EARNINGS_GEO, ISCO, SES_DATASET, SIZE_CLASS, earningsUrl, parseEarnings, type EarningsResult } from '../domain/earnings'
import { marketPrompt, marketResearchPrompt } from '../domain/localAi'
import { ExplicarIA } from '../components/ExplicarIA'
import { axis, compact, grid, SERIES, tooltipStyle } from '../components/charts'
import { money } from '../lib/format'

const eur = money('EUR', 0)
const SCOPES: BenchmarkRole['scope'][] = ['regional', 'global', 'nacional', 'local']
/** Western Europe plus the EU average: the scope the user actually tracks. */
const DEFAULT_GEOS = ['FR', 'PT', 'ES', 'BE', 'NL', 'LU', 'EU27_2020']

/**
 * Market comparison. Every market figure here was written down by the user with its source
 * and date, or read live from Eurostat — nothing is estimated and no model is ever asked to
 * produce a salary. Readings are append-only, so the history shows how the market moved and
 * when each figure was taken.
 */
export function Market() {
  const [roles, setRoles] = useState<BenchmarkRole[] | null>(null)
  const [entries, setEntries] = useState<BenchmarkEntry[]>([])
  const [payslips, setPayslips] = useState<Payslip[]>([])
  const [erro, setErro] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [oficial, setOficial] = useState<EarningsResult | null>(null)

  const load = useCallback(async () => {
    try {
      setErro(null)
      let r = await listRoles()
      if (!r.length) { await seedRoles(); r = await listRoles() }
      setRoles(r)
      setEntries(await listEntries())
      try { setPayslips(await listPayslips()) } catch { /* no payslips yet: the comparison just shows no own pay */ }
    } catch (e) { setErro((e as Error).message) }
  }, [])
  useEffect(() => { load() }, [load])

  const mine = useMemo(() => myGrossYear(payslips.map((p) => ({ period: p.period.slice(0, 7), gross: p.gross }))), [payslips])

  if (erro) return <div className="card err" style={{ whiteSpace: 'pre-wrap' }}>{erro}</div>
  if (!roles) return <div className="card muted">Carregando…</div>

  const done = async (m: string) => { setMsg(m); await load() }

  return (
    <div className="grid" style={{ gridTemplateColumns: '1fr' }}>
      <div className="card">
        <h3>Mercado — comparação com a sua remuneração</h3>
        <p className="muted">
          Todo número de mercado aqui vem de uma fonte que <strong>você</strong> registrou, ou da API de estatística
          oficial do Eurostat. O app faz a comparação; a IA local, quando acionada, só põe em palavras ou propõe um
          plano de pesquisa — ela não tem dados de mercado e está instruída a nunca citar um valor que não esteja na tela.
        </p>
        <div className="kpis">
          <div className="kpi">
            <div className="l">Seu bruto anual</div>
            <div className="v">{mine.value === null ? '—' : eur(mine.value)}</div>
            <div className="l">{mine.from === 'ano' ? '12 holerites reais' : mine.from === 'mes' ? `estimado: último holerite × 12 (só ${mine.months} importado(s))` : 'importe holerites para comparar'}</div>
          </div>
          <div className="kpi"><div className="l">Cargos acompanhados</div><div className="v">{roles.length}</div></div>
          <div className="kpi"><div className="l">Leituras registradas</div><div className="v">{entries.length}</div></div>
        </div>
        {msg && <p className="pos">{msg}</p>}
      </div>

      <Europa roles={roles} busy={busy} setBusy={setBusy} onDone={done} onError={setErro} onLoaded={setOficial} oficial={oficial} />
      <Csv roles={roles} busy={busy} setBusy={setBusy} onDone={done} onError={setErro} />
      <Cargos roles={roles} onDone={load} onError={setErro} />

      {roles.map((role) => (
        <RoleCard key={role.id} cmp={compareRole(role, entries, mine.value)} mine={mine}
          onDelete={async (id) => { await deleteEntry(id); await load() }} />
      ))}

      <Plano roles={roles} entries={entries} oficial={oficial} mine={mine} />
    </div>
  )
}

/** Live official statistics across Western Europe, recorded as dated readings. */
function Europa({ roles, busy, setBusy, onDone, onError, onLoaded, oficial }: {
  roles: BenchmarkRole[]
  busy: boolean
  setBusy: (b: boolean) => void
  onDone: (m: string) => Promise<void>
  onError: (e: string) => void
  onLoaded: (r: EarningsResult | null) => void
  oficial: EarningsResult | null
}) {
  const [isco, setIsco] = useState('OC1')
  const [roleId, setRoleId] = useState(roles[0]?.id ?? '')
  const [pick, setPick] = useState<{ geo: string; size: string } | null>(null)

  async function buscar() {
    setBusy(true)
    try {
      const res = await fetch(earningsUrl(DEFAULT_GEOS, isco), { headers: { Accept: 'application/json' } })
      if (!res.ok) throw new Error(`O Eurostat respondeu ${res.status}.`)
      onLoaded(parseEarnings(await res.json(), DEFAULT_GEOS))
    } catch (e) { onError(`Não foi possível ler o Eurostat: ${(e as Error).message}`); onLoaded(null) } finally { setBusy(false) }
  }

  /** Records one published cell as a reading, so it joins the history like any other. */
  async function registrar() {
    if (!oficial || !pick || !roleId) return
    const geo = oficial.byGeo.find((g) => g.geo === pick.geo)
    const row = geo?.rows.find((r) => r.sizeClass === pick.size)
    if (!geo || !row) return
    setBusy(true)
    try {
      const entry: NewEntry = {
        role_id: roleId,
        as_of: `${oficial.year}-12-31`,
        source: `Eurostat ${SES_DATASET} · ${oficial.iscoLabel} · ${geo.label} · ${row.sizeLabel}`,
        source_url: `https://ec.europa.eu/eurostat/databrowser/view/${SES_DATASET}/default/table`,
        basis: 'gross_month',
        currency: 'EUR',
        p25: null, p50: row.monthly, p75: null,
        sample_size: null,
        official: true,
        notes: 'Média (não mediana) do ganho mensal bruto. Grupo amplo de ocupações: âncora oficial, não grupo de pares.',
      }
      const n = await addEntries([entry])
      await onDone(n
        ? `Registrado: ${geo.label}, ${oficial.iscoLabel}, empresas ${row.sizeLabel} — ${eur(row.monthly)}/mês, referência ${oficial.year}.`
        : 'Essa leitura oficial já estava registrada nessa data — o histórico não foi duplicado.')
      setPick(null)
    } catch (e) { onError((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="card">
      <h3>Europa — estatística oficial, lida da web</h3>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        Eurostat, inquérito de estrutura dos salários ({SES_DATASET}): ganho mensal bruto <strong>médio</strong> por
        ocupação e porte de empresa. Oficial, sem chave, lido direto do navegador sempre que você estiver conectado.
        <br /><strong>Leia com cuidado:</strong> a ocupação mais fina que esse inquérito publica é o grande grupo ISCO —
        “Diretores e gerentes” cobre um CIO e um gerente de loja igualmente. Serve de âncora, não de grupo de pares.
        E é uma <em>média</em>, não uma mediana, então não entra nas faixas p25/p75.
      </p>
      <div className="row">
        <label className="inline">Ocupação
          <select value={isco} onChange={(e) => setIsco(e.target.value)} disabled={busy}>
            {ISCO.map((i) => <option key={i.code} value={i.code}>{i.label}</option>)}
          </select></label>
        <button className="primary" onClick={buscar} disabled={busy}>{busy ? 'Buscando…' : 'Buscar na Europa'}</button>
      </div>

      {oficial && <>
        <p className="muted" style={{ fontSize: 13 }}>
          {oficial.iscoLabel} · referência {oficial.year}
          {oficial.updated ? ` · publicado em ${oficial.updated.slice(0, 10)}` : ''} · valores em EUR por mês.
        </p>
        <div className="scroll"><table>
          <thead><tr><th>País</th>{SIZE_CLASS.map((s) => <th key={s.code} className="num">{s.label}</th>)}</tr></thead>
          <tbody>{oficial.byGeo.map((g) => (
            <tr key={g.geo} style={g.geo === 'EU27_2020' ? { fontStyle: 'italic' } : undefined}>
              <td>{g.label}</td>
              {SIZE_CLASS.map((s) => {
                const row = g.rows.find((r) => r.sizeClass === s.code)
                const chosen = pick?.geo === g.geo && pick?.size === s.code
                return (
                  <td key={s.code} className="num">
                    {row
                      ? <button className="link" style={{ fontWeight: chosen ? 700 : 400 }}
                        title={`Registrar ${g.label}, empresas ${s.label}`}
                        onClick={() => setPick(chosen ? null : { geo: g.geo, size: s.code })}>{eur(row.monthly)}</button>
                      : <span className="muted" title="O Eurostat não publica esta combinação (amostra pequena ou sigilo)">·</span>}
                  </td>
                )
              })}
            </tr>
          ))}</tbody>
        </table></div>
        {oficial.withheld.length > 0 && (
          <p className="muted" style={{ fontSize: 12 }}>
            Sem nenhum valor publicado para esta ocupação: {oficial.withheld.join(', ')}. O Eurostat omite células com
            amostra pequena — ausência não é zero.
          </p>
        )}
        <div className="row" style={{ marginTop: 8 }}>
          <label className="inline">Registrar em
            <select value={roleId} onChange={(e) => setRoleId(e.target.value)} disabled={busy}>
              {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select></label>
          <button className="primary" onClick={registrar} disabled={busy || !pick || !roleId}>
            {pick ? 'Registrar o valor escolhido' : 'Clique num valor da tabela'}
          </button>
        </div>
      </>}
    </div>
  )
}

/** One role: its readings, the history of its median, and the narration. */
function RoleCard({ cmp, mine, onDelete }: {
  cmp: ReturnType<typeof compareRole>
  mine: ReturnType<typeof myGrossYear>
  onDelete: (id: string) => Promise<void>
}) {
  const { role, latest, history } = cmp
  const chart = history.map((h) => ({ label: h.as_of.slice(0, 7), mediana: Math.round(h.p50GrossYear) }))

  const facts = () => marketPrompt({
    cargo: role.name,
    regiao: role.region,
    moeda: 'EUR',
    meuBrutoAno: mine.value,
    origemDoMeu: mine.from,
    leituras: latest.map((l) => ({
      fonte: l.entry.source,
      data: l.entry.as_of,
      base: BASIS_LABEL[l.entry.basis],
      oficial: l.entry.official,
      p25: l.entry.p25, p50: l.entry.p50, p75: l.entry.p75,
      amostra: l.entry.sample_size,
      faixa: l.position?.band ?? 'sem comparação possível',
      diferencaAteMediana: l.position?.gapToMedian ?? null,
    })),
    historico: history.map((h) => ({ data: h.as_of, fonte: h.source, medianaAno: Math.round(h.p50GrossYear) })),
  })

  return (
    <div className="card">
      <h3>{role.name} <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>· {role.scope}{role.region ? ` · ${role.region}` : ''}</span></h3>
      {role.notes && <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>{role.notes}</p>}

      {!latest.length ? (
        <p className="muted">Nenhuma leitura registrada para este cargo. Busque a estatística oficial acima ou importe uma base em CSV.</p>
      ) : (
        <div className="scroll"><table>
          <thead><tr>
            <th>Fonte</th><th>Data</th><th>Base</th><th className="num">p25</th><th className="num">Mediana</th><th className="num">p75</th>
            <th className="num hide-sm">Amostra</th><th>Sua posição</th><th />
          </tr></thead>
          <tbody>{latest.map(({ entry, position }) => (
            <tr key={entry.id}>
              <td>
                {entry.source_url
                  ? <a href={entry.source_url} target="_blank" rel="noreferrer noopener">{entry.source}</a>
                  : entry.source}
                {entry.official && <span className="pos" style={{ fontSize: 12 }}> · oficial</span>}
                {entry.notes && <div className="muted" style={{ fontSize: 12 }}>{entry.notes}</div>}
              </td>
              <td style={{ whiteSpace: 'nowrap' }}>{entry.as_of}</td>
              <td className="muted" style={{ fontSize: 12 }}>{BASIS_LABEL[entry.basis]}{entry.currency !== 'EUR' ? ` · ${entry.currency}` : ''}</td>
              <td className="num">{entry.p25 === null ? '·' : eur(entry.p25)}</td>
              <td className="num"><strong>{entry.p50 === null ? '·' : eur(entry.p50)}</strong></td>
              <td className="num">{entry.p75 === null ? '·' : eur(entry.p75)}</td>
              <td className="num hide-sm">{entry.sample_size ?? '·'}</td>
              <td className={position?.band === 'abaixo de p25' ? 'neg' : position?.band === 'acima de p75' ? 'pos' : ''}>
                {position ? position.band : <span className="muted">base não convertível</span>}
                {position?.gapToMedian != null && Math.abs(position.gapToMedian) > 1 && (
                  <div className="muted" style={{ fontSize: 12 }}>
                    mediana {position.gapToMedian > 0 ? 'acima' : 'abaixo'} em {eur(Math.abs(position.gapToMedian))}
                  </div>
                )}
              </td>
              <td><button onClick={() => onDelete(entry.id)} aria-label={`Excluir leitura de ${entry.source}`} title="Excluir esta leitura">✕</button></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}

      {chart.length > 1 && <>
        <h4>Histórico da mediana</h4>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={chart}>
            <CartesianGrid {...grid} /><XAxis dataKey="label" {...axis} /><YAxis {...axis} tickFormatter={compact} width={52} />
            <Tooltip {...tooltipStyle} formatter={(v) => eur(Number(v))} labelFormatter={(l) => `Referência de ${l}`} /><Legend />
            <Line dataKey="mediana" name="Mediana (bruto anual)" stroke={SERIES[0]} strokeWidth={2} dot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
        <p className="muted" style={{ fontSize: 12 }}>
          Cada ponto é uma leitura registrada, na data a que ela se refere. Fontes diferentes medem de formas diferentes,
          então uma subida no gráfico pode ser troca de fonte, não movimento do mercado.
        </p>
      </>}

      {latest.length > 0 && <ExplicarIA build={facts} signature={`${role.id}|${latest.length}|${mine.value ?? 0}`}
        note="Texto escrito por um modelo local a partir das leituras desta tela. O modelo não tem dados de mercado: se citar um número, ele veio da tabela acima." />}
    </div>
  )
}

/** The AI proposing how to research the market — never what the market pays. */
function Plano({ roles, entries, oficial, mine }: {
  roles: BenchmarkRole[]
  entries: BenchmarkEntry[]
  oficial: EarningsResult | null
  mine: ReturnType<typeof myGrossYear>
}) {
  const build = () => marketResearchPrompt({
    paises: EARNINGS_GEO.filter((g) => DEFAULT_GEOS.includes(g.code) && g.code !== 'EU27_2020').map((g) => g.label),
    moeda: 'EUR',
    meuBrutoAno: mine.value,
    anoOficial: oficial?.year ?? 0,
    ocupacaoOficial: oficial?.iscoLabel ?? 'não consultada',
    oficial: (oficial?.byGeo ?? []).map((g) => ({ pais: g.label, porte: g.headline?.sizeLabel ?? '—', mediaMes: g.headline?.monthly ?? null })),
    cargos: roles.map((r) => {
      const mineRole = entries.filter((e) => e.role_id === r.id)
      return {
        nome: r.name, regiao: r.region, abrangencia: r.scope,
        leituras: mineRole.length,
        fontesUsadas: [...new Set(mineRole.map((e) => e.source.split(' · ')[0]))].slice(0, 6),
        maisRecente: mineRole.map((e) => e.as_of).sort().at(-1) ?? null,
      }
    }),
  })

  return (
    <div className="card">
      <h3>Propor uma análise de mercado</h3>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        Aqui a IA local é usada para o que ela de fato consegue fazer sobre este assunto: montar o <strong>plano</strong> —
        que tipo de fonte consultar por país, que lacunas existem no que você já registrou e como tornar as leituras
        comparáveis entre países. Ela não tem dados salariais e está proibida de citar valor que não esteja na tela.
      </p>
      <ExplicarIA build={build} label="Propor plano de pesquisa"
        signature={`plano|${roles.length}|${entries.length}|${oficial?.year ?? 0}`}
        note="Plano sugerido por um modelo local. Ele não conhece o conteúdo atual das fontes: confirme o que cada estudo publica e de que ano é antes de usar." />
    </div>
  )
}

/** Reading a base from a file: any survey table saved as CSV. */
function Csv({ roles, busy, setBusy, onDone, onError }: {
  roles: BenchmarkRole[]
  busy: boolean
  setBusy: (b: boolean) => void
  onDone: (m: string) => Promise<void>
  onError: (e: string) => void
}) {
  const [preview, setPreview] = useState<{ entries: ImportedEntry[]; newRoles: { name: string; region: string }[]; errors: string[] } | null>(null)

  function ler(file: File) {
    Papa.parse<Record<string, string>>(file, {
      header: true, skipEmptyLines: true,
      complete: (res) => setPreview(parseBenchmarkRows(res.data, roles)),
      error: (e) => onError(`Não foi possível ler o arquivo: ${e.message}`),
    })
  }

  async function gravar() {
    if (!preview) return
    setBusy(true)
    try {
      const byName = new Map(roles.map((r) => [r.name.toLowerCase(), r.id]))
      for (const nr of preview.newRoles) {
        const created = await addRole({ name: nr.name, scope: 'regional', region: nr.region, notes: '', sort: roles.length })
        byName.set(nr.name.toLowerCase(), created.id)
      }
      const rows: NewEntry[] = []
      for (const e of preview.entries) {
        const id = byName.get(e.roleName.toLowerCase())
        if (!id) continue
        rows.push({
          role_id: id, as_of: e.as_of, source: e.source, source_url: e.source_url, basis: e.basis,
          currency: e.currency, p25: e.p25, p50: e.p50, p75: e.p75, sample_size: e.sample_size,
          official: e.official, notes: e.notes,
        })
      }
      const n = await addEntries(rows)
      setPreview(null)
      await onDone(`${n} leitura(s) gravadas de ${rows.length} linha(s)`
        + (rows.length - n > 0 ? ` · ${rows.length - n} já existiam e foram mantidas como estavam` : '')
        + (preview.newRoles.length ? ` · ${preview.newRoles.length} cargo(s) criados` : '') + '.')
    } catch (e) { onError((e as Error).message) } finally { setBusy(false) }
  }

  function modelo() {
    const url = URL.createObjectURL(new Blob(['﻿' + CSV_EXAMPLE], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url; a.download = 'modelo-benchmarking.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="card">
      <h3>Importar uma base em CSV</h3>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        Para o número do <em>seu</em> cargo, que nenhuma API aberta publica: qualquer tabela (estudo de cadres,
        convenção coletiva, consultoria de recrutamento, estudo interno) salva como CSV. Lida no navegador, como os
        extratos — o arquivo não sai do computador.
        <br />Colunas, em qualquer ordem: <code>{CSV_HEADER}</code>. Obrigatórias: cargo, data, fonte e p50.
      </p>
      <div className="row">
        <button onClick={modelo}>Baixar modelo CSV</button>
        <label className="inline"><span className="muted">Escolher arquivo</span>
          <input type="file" accept=".csv,text/csv" disabled={busy}
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) ler(f) }} /></label>
      </div>

      {preview && <>
        {preview.errors.length > 0 && <details open>
          <summary className="err">{preview.errors.length} linha(s) não puderam ser lidas</summary>
          {preview.errors.slice(0, 20).map((x) => <p key={x} className="err" style={{ fontSize: 13 }}>{x}</p>)}
        </details>}
        {preview.entries.length === 0
          ? <p className="warn">Nenhuma linha válida no arquivo.</p>
          : <>
            <p><strong>{preview.entries.length} leitura(s) prontas</strong>
              {preview.newRoles.length > 0 && ` · ${preview.newRoles.length} cargo(s) novos serão criados: ${preview.newRoles.map((r) => r.name).join(', ')}`}</p>
            <div className="scroll" style={{ maxHeight: 260, overflowY: 'auto' }}><table>
              <thead><tr><th>Cargo</th><th>Data</th><th>Fonte</th><th>Base</th><th className="num">p25</th><th className="num">p50</th><th className="num">p75</th></tr></thead>
              <tbody>{preview.entries.map((e, i) => (
                <tr key={i}>
                  <td>{e.roleName}</td><td>{e.as_of}</td><td>{e.source}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{BASIS_LABEL[e.basis]} · {e.currency}</td>
                  <td className="num">{e.p25 ?? '·'}</td><td className="num">{e.p50 ?? '·'}</td><td className="num">{e.p75 ?? '·'}</td>
                </tr>
              ))}</tbody>
            </table></div>
            <div className="row" style={{ marginTop: 8 }}>
              <button className="primary" onClick={gravar} disabled={busy}>Gravar {preview.entries.length} leitura(s)</button>
              <button onClick={() => setPreview(null)} disabled={busy}>Descartar</button>
            </div>
            <p className="muted" style={{ fontSize: 12 }}>
              Nada é sobrescrito: uma leitura que repita cargo, data, fonte e base é mantida como já estava, para o
              histórico não ser reescrito.
            </p>
          </>}
      </>}
    </div>
  )
}

/** Adding and removing the roles being tracked. */
function Cargos({ roles, onDone, onError }: { roles: BenchmarkRole[]; onDone: () => Promise<void>; onError: (e: string) => void }) {
  const [open, setOpen] = useState(false)
  const [nome, setNome] = useState('')
  const [scope, setScope] = useState<BenchmarkRole['scope']>('regional')
  const [region, setRegion] = useState('Europa')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)

  async function criar() {
    if (!nome.trim()) return
    setBusy(true)
    try {
      await addRole({ name: nome.trim(), scope, region: region.trim(), notes: notes.trim(), sort: roles.length })
      setNome(''); setNotes('')
      await onDone()
    } catch (e) { onError((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="card">
      <div className="row">
        <h3 style={{ margin: 0 }}>Cargos acompanhados</h3>
        <button onClick={() => setOpen(!open)}>{open ? 'Fechar' : '+ Novo cargo'}</button>
      </div>
      {open && <>
        <div className="form" style={{ marginTop: 8 }}>
          <label>Cargo<input value={nome} onChange={(e) => setNome(e.target.value)} placeholder="ex.: Head de Dados global" disabled={busy}
            onKeyDown={(e) => { if (e.key === 'Enter') criar() }} /></label>
          <label>Abrangência<select value={scope} onChange={(e) => setScope(e.target.value as BenchmarkRole['scope'])} disabled={busy}>
            {SCOPES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select></label>
          <label>Região<input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="Europa, França, Brasil…" disabled={busy} /></label>
          <label>Observação<input value={notes} onChange={(e) => setNotes(e.target.value)} disabled={busy} /></label>
        </div>
        <div className="row"><button className="primary" onClick={criar} disabled={busy || !nome.trim()}>Criar cargo</button></div>
      </>}

      <div className="scroll"><table>
        <thead><tr><th>Cargo</th><th>Abrangência</th><th>Região</th><th /></tr></thead>
        <tbody>{roles.map((r) => (
          <tr key={r.id}>
            <td>{r.name}{r.notes && <div className="muted" style={{ fontSize: 12 }}>{r.notes}</div>}</td>
            <td>{r.scope}</td><td>{r.region}</td>
            <td><button aria-label={`Excluir ${r.name}`} title="Excluir o cargo e todas as suas leituras"
              onClick={async () => {
                if (!confirm(`Excluir "${r.name}" e todo o histórico de leituras dele?`)) return
                try { await deleteRole(r.id); await onDone() } catch (e) { onError((e as Error).message) }
              }}>✕</button></td>
          </tr>
        ))}</tbody>
      </table></div>
    </div>
  )
}
