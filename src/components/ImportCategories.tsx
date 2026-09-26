import { useMemo, useState } from 'react'
import type { Ctx } from '../App'
import { categorize, merchantKey } from '../domain/categorize'
import { addCategory, addRule, type ImportPlan } from '../lib/data'
import type { CategoryKind } from '../domain/types'

const TIPO: Record<CategoryKind, string> = { expense: 'despesa', income: 'receita', transfer: 'transferência' }
const PADRAO = new Set(['Outros', 'Outras receitas'])

interface Pendente {
  merchant: string
  linhas: number
  total: number
  exemplo: string
  currency: string
}

/**
 * Mostra, antes de gravar, o que vai entrar sem categoria e deixa resolver na hora.
 * Definir aqui cria a regra do estabelecimento, então as linhas já nascem
 * categorizadas — não é preciso importar e corrigir depois.
 */
export function ImportCategories({ ctx, plans }: { ctx: Ctx; plans: ImportPlan[] }) {
  const { data } = ctx
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [escolha, setEscolha] = useState<Record<string, string>>({})
  const [criandoPara, setCriandoPara] = useState<string | null>(null)
  const [nome, setNome] = useState('')
  const [tipo, setTipo] = useState<CategoryKind>('expense')

  const cats = useMemo(() => [...data.categories].sort((a, b) => a.name.localeCompare(b.name)), [data.categories])

  const pendentes = useMemo(() => {
    const bankByRef = new Map(data.accounts.map((a) => [a.external_ref, a.bank]))
    const grupos = new Map<string, Pendente>()
    for (const p of plans) {
      for (const t of p.result.transactions) {
        // Itaú usa 0000/00000-0 como número de conta; o resto é BCP.
        const bank = bankByRef.get(t.accountRef) ?? (t.accountRef.includes('/') ? 'ITAU' : 'BCP')
        const nome = categorize(t as never, data.rules, data.bankMap, bank)
        if (!PADRAO.has(nome)) continue
        const key = merchantKey(t.description)
        if (key.length < 2) continue
        const g = grupos.get(key) ?? { merchant: key, linhas: 0, total: 0, exemplo: t.description, currency: t.currency }
        g.linhas++
        g.total += Math.abs(t.amount)
        grupos.set(key, g)
      }
    }
    return [...grupos.values()].sort((a, b) => b.total - a.total)
  }, [plans, data.rules, data.bankMap, data.accounts])

  async function criarCategoria(merchant: string) {
    const limpo = nome.trim()
    if (!limpo) return
    setBusy(true); setMsg(null)
    try {
      const repetida = data.categories.find((c) => c.name.toLowerCase() === limpo.toLowerCase())
      const criada = repetida ?? (await addCategory(limpo, tipo, '#888888', data.categories.length))
      setEscolha({ ...escolha, [merchant]: criada.id })
      setCriandoPara(null); setNome('')
      await ctx.reload()
    } catch (e) { setMsg((e as Error).message) } finally { setBusy(false) }
  }

  async function definir(merchant: string) {
    const categoryId = escolha[merchant]
    if (!categoryId) return
    setBusy(true); setMsg(null)
    try {
      const priority = Math.min(1000, ...data.rules.map((r) => r.priority)) - 1
      await addRule(merchant, categoryId, null, priority)
      setMsg(`Regra criada para “${merchant}”. As linhas desse estabelecimento já entram categorizadas.`)
      await ctx.reload() // recarrega as regras: o estabelecimento sai desta lista
    } catch (e) { setMsg((e as Error).message) } finally { setBusy(false) }
  }

  async function definirTodos() {
    const alvos = pendentes.filter((p) => escolha[p.merchant])
    if (!alvos.length) return
    setBusy(true); setMsg(null)
    try {
      let priority = Math.min(1000, ...data.rules.map((r) => r.priority)) - 1
      for (const p of alvos) { await addRule(p.merchant, escolha[p.merchant], null, priority); priority-- }
      setMsg(`${alvos.length} regra(s) criada(s) antes do import.`)
      await ctx.reload()
    } catch (e) { setMsg((e as Error).message) } finally { setBusy(false) }
  }

  if (!plans.length) return null
  if (!pendentes.length) {
    return <p className="pos">Tudo que vai entrar já cai numa categoria — nada para definir antes de importar.</p>
  }

  const definidos = pendentes.filter((p) => escolha[p.merchant]).length

  return (
    <div style={{ marginTop: 12 }}>
      <h4>Definir categoria antes de importar</h4>
      <p className="muted">
        {pendentes.length} estabelecimento(s) destes arquivos cairiam em “Outros”. Definir a categoria aqui cria a regra,
        e as linhas já entram no lugar certo. O que você deixar em branco entra como “Outros” e pode ser ajustado depois.
      </p>
      {definidos > 1 && <div className="row"><button className="primary" onClick={definirTodos} disabled={busy}>Definir os {definidos} escolhidos</button></div>}
      <div className="scroll"><table>
        <thead><tr><th>Estabelecimento</th><th className="hide-sm">Exemplo no extrato</th><th className="num">Linhas</th><th>Categoria</th><th /></tr></thead>
        <tbody>{pendentes.map((p) => (
          <tr key={p.merchant}>
            <td><strong>{p.merchant}</strong></td>
            <td className="hide-sm muted" style={{ fontSize: 12, maxWidth: 260 }}>{p.exemplo}</td>
            <td className="num">{p.linhas}</td>
            <td>
              {criandoPara === p.merchant ? (
                <div className="row">
                  <input placeholder="Nome da categoria" value={nome} onChange={(e) => setNome(e.target.value)} disabled={busy}
                    onKeyDown={(e) => { if (e.key === 'Enter') criarCategoria(p.merchant) }} />
                  <select value={tipo} onChange={(e) => setTipo(e.target.value as CategoryKind)} disabled={busy}>
                    {(Object.keys(TIPO) as CategoryKind[]).map((k) => <option key={k} value={k}>{TIPO[k]}</option>)}
                  </select>
                  <button className="primary" onClick={() => criarCategoria(p.merchant)} disabled={busy || !nome.trim()}>Criar</button>
                  <button onClick={() => setCriandoPara(null)} disabled={busy}>Cancelar</button>
                </div>
              ) : (
                <div className="row">
                  <select value={escolha[p.merchant] ?? ''} disabled={busy}
                    onChange={(e) => setEscolha({ ...escolha, [p.merchant]: e.target.value })}>
                    <option value="">—</option>
                    {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <button onClick={() => { setCriandoPara(p.merchant); setNome(''); setMsg(null) }} disabled={busy} aria-label={`Nova categoria para ${p.merchant}`}>+</button>
                </div>
              )}
            </td>
            <td><button onClick={() => definir(p.merchant)} disabled={busy || !escolha[p.merchant]}>Definir</button></td>
          </tr>
        ))}</tbody>
      </table></div>
      {msg && <p className="pos">{msg}</p>}
    </div>
  )
}
