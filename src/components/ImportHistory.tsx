import { useEffect, useMemo, useState } from 'react'
import type { Ctx } from '../App'
import { listImports, undoImports, type ImportRecord } from '../lib/data'

const SOURCE: Record<string, string> = {
  bcp_csv: 'BCP (CSV)', bcp_pdf: 'BCP (PDF)', ccf_pdf: 'CCF', itau_pdf: 'Itaú (app)', itau_monthly_pdf: 'Itaú (extrato mensal)',
  itau_card_xlsx: 'Cartão Itaú (Excel)', itau_card_pdf: 'Cartão Itaú (PDF)', millennium_pdf: 'Millennium',
}

/**
 * Every imported file, newest first, with how many of its rows are still stored. Selected
 * files can be undone ("estornar"): their rows and import record go, so they can be
 * imported again.
 */
export function ImportHistory({ ctx }: { ctx: Ctx }) {
  const [list, setList] = useState<ImportRecord[] | null>(null)
  const [sel, setSel] = useState<Set<string>>(() => new Set())
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  // Reload whenever the data changes (after an import or an undo).
  useEffect(() => {
    let alive = true
    listImports().then((l) => { if (alive) setList(l) }, (e: Error) => { if (alive) setMsg(e.message) })
    return () => { alive = false }
  }, [ctx.data])

  const rowsOf = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of ctx.data.transactions) if (t.import_id) m.set(t.import_id, (m.get(t.import_id) ?? 0) + 1)
    return m
  }, [ctx.data.transactions])

  const qq = q.trim().toLowerCase()
  const shown = (list ?? []).filter((r) => !qq || r.file_name.toLowerCase().includes(qq) || (SOURCE[r.source] ?? r.source).toLowerCase().includes(qq))
  const chosen = shown.filter((r) => sel.has(r.id))
  const chosenRows = chosen.reduce((s, r) => s + (rowsOf.get(r.id) ?? 0), 0)
  const allSel = shown.length > 0 && shown.every((r) => sel.has(r.id))

  async function estornar() {
    if (!chosen.length) return
    if (!confirm(`Estornar ${chosen.length} arquivo(s)? ${chosenRows} lançamento(s) serão apagados e os arquivos poderão ser importados de novo.`)) return
    setBusy(true); setMsg(null)
    try {
      const n = await undoImports(chosen)
      setMsg(`${chosen.length} arquivo(s) estornado(s) · ${n} lançamento(s) apagado(s).`)
      setSel(new Set())
      await ctx.reload()
    } catch (e) { setMsg((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="card" style={{ gridColumn: '1/-1' }}>
      <h3>Arquivos importados</h3>
      <p className="muted">
        Estornar um arquivo apaga os lançamentos que ele criou e o registro da importação, para você poder importar de novo.
        Linhas que outro arquivo já tinha trazido ficam com aquele arquivo.
      </p>
      <div className="row">
        <input placeholder="Filtrar por nome ou banco (ex.: Itaú)" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="primary" onClick={estornar} disabled={busy || !chosen.length}>
          Estornar {chosen.length ? `${chosen.length} arquivo(s) · ${chosenRows} lançamento(s)` : 'selecionados'}</button>
        {msg && <span className="muted">{msg}</span>}
      </div>
      {list === null ? <p className="muted">Carregando…</p> : !list.length ? <p className="muted">Nenhum arquivo importado.</p> : (
        <div className="scroll" style={{ maxHeight: 420, overflowY: 'auto' }}><table>
          <thead><tr>
            <th><input type="checkbox" checked={allSel} aria-label="Selecionar todos os visíveis"
              onChange={() => setSel(allSel ? new Set() : new Set(shown.map((r) => r.id)))} /></th>
            <th>Arquivo</th><th className="hide-sm">Tipo</th><th className="hide-sm">Importado em</th>
            <th className="num">Linhas gravadas</th><th className="num">Ainda na base</th>
          </tr></thead>
          <tbody>{shown.map((r) => (
            <tr key={r.id}>
              <td><input type="checkbox" checked={sel.has(r.id)} disabled={busy} aria-label={`Selecionar ${r.file_name}`}
                onChange={() => setSel((prev) => { const s = new Set(prev); if (s.has(r.id)) s.delete(r.id); else s.add(r.id); return s })} /></td>
              <td style={{ wordBreak: 'break-all' }}>{r.file_name}</td>
              <td className="hide-sm">{SOURCE[r.source] ?? r.source}</td>
              <td className="hide-sm">{r.created_at.slice(0, 16).replace('T', ' ')}</td>
              <td className="num">{r.rows_inserted}</td>
              <td className="num">{rowsOf.get(r.id) ?? 0}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  )
}
