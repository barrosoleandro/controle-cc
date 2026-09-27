import { useState } from 'react'
import { summarize } from '../../domain/explore'
import { fullDate, useSort, type ViewProps } from './util'

const PAGE = 200

/** The rows behind every number on the page, with a CSV of exactly this slice. */
export function RowsView(p: ViewProps) {
  const { fmt, rows } = p
  const [limit, setLimit] = useState(PAGE)
  const { sorted, Th } = useSort(rows, 'day', (r, k) => (k === 'amt' ? r.amt : String(r[k as 'day' | 'merchant' | 'categoryName' | 'accountName'])))
  const s = summarize(rows)

  const exportCsv = () => {
    const q = (x: string) => `"${x.replace(/"/g, '""')}"`
    const lines = ['data_compra;data_lancamento;descricao;estabelecimento;categoria;conta;valor',
      ...sorted.map((t) => [t.day, t.booking_date, q(t.description), q(t.merchant), q(t.categoryName), q(t.accountName), t.amt.toFixed(2).replace('.', ',')].join(';'))]
    const url = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv' }))
    const a = document.createElement('a'); a.href = url; a.download = `analise-${p.range.from}-${p.range.to}.csv`; a.click(); URL.revokeObjectURL(url)
  }

  return (
    <div className="card">
      <div className="card-head">
        <h3>{rows.length.toLocaleString('pt-BR')} lançamentos · {fmt(s.total)}</h3>
        <button onClick={exportCsv} disabled={!rows.length}>Exportar CSV</button>
      </div>
      <div className="scroll">
        <table className="tight">
          <thead><tr>
            <Th k="day">Data</Th><Th k="merchant">Estabelecimento</Th><Th k="categoryName">Categoria</Th>
            <Th k="accountName">Conta</Th><Th k="amt" num>Valor</Th>
          </tr></thead>
          <tbody>
            {sorted.slice(0, limit).map((t) => (
              <tr key={t.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{fullDate(t.day)}</td>
                <td><button className="link" onClick={() => p.onMerchant(t.merchant)}>{t.merchant}</button><div className="muted" style={{ fontSize: 12 }}>{t.description}</div></td>
                <td><button className="link" onClick={() => p.onCategory(t.categoryName)}>{t.categoryName}</button></td>
                <td className="muted">{t.accountName}</td>
                <td className={`num ${t.amt < 0 ? 'muted' : ''}`}>{fmt(t.amt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sorted.length > limit && <button style={{ marginTop: 8 }} onClick={() => setLimit(limit + PAGE * 2)}>Mostrar mais ({sorted.length - limit})</button>}
      <p className="muted" style={{ fontSize: 12 }}>Valores negativos são estornos dentro da categoria. O CSV sai com este filtro e esta ordem.</p>
    </div>
  )
}
