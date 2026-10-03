import { supabase } from './supabase'
import type { BenchmarkEntry, BenchmarkRole } from '../domain/market'
import { SEED_ROLES } from '../domain/market'

const NUMERIC = ['p25', 'p50', 'p75'] as const

function missing(msg: string): string {
  return /benchmark_(roles|entries)/.test(msg)
    ? 'Tabelas de benchmarking não encontradas: rode supabase/migrations/005_benchmarks.sql no SQL Editor do Supabase.'
    : msg
}

export async function listRoles(): Promise<BenchmarkRole[]> {
  const { data, error } = await supabase.from('benchmark_roles').select('*').order('sort').order('name')
  if (error) throw new Error(missing(error.message))
  return data as BenchmarkRole[]
}

export async function listEntries(): Promise<BenchmarkEntry[]> {
  const all: BenchmarkEntry[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('benchmark_entries').select('*')
      .order('as_of', { ascending: false }).order('id').range(from, from + 999)
    if (error) throw new Error(missing(error.message))
    // PostgREST returns numerics as strings.
    all.push(...(data as BenchmarkEntry[]).map((e) => {
      const out = { ...e }
      for (const k of NUMERIC) out[k] = e[k] === null ? null : Number(e[k])
      out.sample_size = e.sample_size === null ? null : Number(e.sample_size)
      return out
    }))
    if (data.length < 1000) break
  }
  return all
}

/** First use: the three roles the user tracks today, so the screen is not empty. */
export async function seedRoles(): Promise<void> {
  const { error } = await supabase.from('benchmark_roles').insert(SEED_ROLES)
  if (error) throw new Error(missing(error.message))
}

export async function addRole(role: Omit<BenchmarkRole, 'id'>): Promise<BenchmarkRole> {
  const { data, error } = await supabase.from('benchmark_roles').insert(role).select().single()
  if (error) throw new Error(missing(error.message))
  return data as BenchmarkRole
}

export async function updateRole(id: string, patch: Partial<BenchmarkRole>): Promise<void> {
  const { error } = await supabase.from('benchmark_roles').update(patch).eq('id', id)
  if (error) throw new Error(missing(error.message))
}

/** Deleting a role takes its readings with it (on delete cascade), so it asks first in the UI. */
export async function deleteRole(id: string): Promise<void> {
  const { error } = await supabase.from('benchmark_roles').delete().eq('id', id)
  if (error) throw new Error(missing(error.message))
}

export type NewEntry = Omit<BenchmarkEntry, 'id'>

/**
 * Records readings. History is the point, so nothing is overwritten: a row that repeats
 * the same role, date, source and basis is skipped by the unique index instead of
 * replacing what is already there.
 */
export async function addEntries(rows: NewEntry[]): Promise<number> {
  if (!rows.length) return 0
  let written = 0
  for (let i = 0; i < rows.length; i += 200) {
    const slice = rows.slice(i, i + 200)
    const { data, error } = await supabase.from('benchmark_entries')
      .upsert(slice, { onConflict: 'user_id,role_id,as_of,source,basis', ignoreDuplicates: true })
      .select('id')
    if (error) throw new Error(missing(error.message))
    written += data?.length ?? 0
  }
  return written
}

export async function deleteEntry(id: string): Promise<void> {
  const { error } = await supabase.from('benchmark_entries').delete().eq('id', id)
  if (error) throw new Error(missing(error.message))
}
