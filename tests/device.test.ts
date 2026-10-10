import { describe, expect, it } from 'vitest'
import { guessName, matchDevice, normalizeGpu, uniqueName, type Device, type Hardware } from '../src/domain/device'

const QWEN35 = '2a654d98e6fba55d452b7043684e9b57a947e393bbffa62485a7aac05ee4eefd'
const CODER = 'd7372fd828518a4d38b1eb196c673c31a85f2ed302b3d1e406c4c2d1b64a0668'
const LLAMA = 'aaaa'

const SURFACE: Hardware = { os: 'Windows', cores: 8, memory: 8, gpu: 'Intel, Intel(R) Iris(R) Xe Graphics' }
const DESKTOP: Hardware = { os: 'Windows', cores: 16, memory: 8, gpu: 'NVIDIA, NVIDIA GeForce RTX 4070' }

const device = (id: string, hardware: Hardware, model_digests: string[] = []): Device => ({
  id, name: id, hardware, model_digests,
  ollama_url: 'http://localhost:11434', ollama_model: '', ollama_enabled: true, last_seen_at: null,
})

describe('the GPU as a machine signature', () => {
  it('keeps the card and drops what changes with the browser or driver', () => {
    expect(normalizeGpu('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)'))
      .toBe('Intel, Intel(R) Iris(R) Xe Graphics')
    expect(normalizeGpu('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0)'))
      .toBe('Intel, Intel(R) Iris(R) Xe Graphics')
    expect(normalizeGpu('ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)'))
      .toBe('NVIDIA, NVIDIA GeForce RTX 4070')
    expect(normalizeGpu('Apple M2')).toBe('Apple M2')
    expect(normalizeGpu('')).toBeUndefined()
    expect(normalizeGpu(null)).toBeUndefined()
  })
})

describe('recognising this computer', () => {
  const surface = device('SURFACE_L', SURFACE, [QWEN35, CODER])
  const desktop = device('DESKTOP', DESKTOP, [QWEN35, LLAMA])

  it('trusts the id this browser remembered', () => {
    expect(matchDevice([surface, desktop], { storedId: 'DESKTOP', hardware: SURFACE, digests: [] })?.id).toBe('DESKTOP')
  })

  it('ignores a remembered id that no longer exists and looks again', () => {
    expect(matchDevice([surface, desktop], { storedId: 'gone', hardware: SURFACE, digests: [] })?.id).toBe('SURFACE_L')
  })

  it('finds the seeded entry by its models alone, before any hardware was stored', () => {
    const seeded = device('SURFACE_L', {}, [QWEN35, CODER])
    expect(matchDevice([seeded, desktop], { hardware: SURFACE, digests: [QWEN35, CODER] })?.id).toBe('SURFACE_L')
  })

  it('still recognises it after a new model is pulled', () => {
    expect(matchDevice([surface, desktop], { hardware: { os: 'Windows' }, digests: [QWEN35, CODER, 'new'] })?.id).toBe('SURFACE_L')
  })

  it('does not take one shared model as proof of being the same machine', () => {
    expect(matchDevice([surface], { hardware: { os: 'Windows' }, digests: [QWEN35, LLAMA, 'x', 'y'] })).toBeNull()
  })

  it('never matches across operating systems', () => {
    expect(matchDevice([surface], { hardware: { ...SURFACE, os: 'macOS' }, digests: [QWEN35, CODER] })).toBeNull()
  })

  it('does not match on cores and memory alone: too many machines share them', () => {
    expect(matchDevice([surface], { hardware: { os: 'Windows', cores: 8, memory: 8 }, digests: [] })).toBeNull()
  })

  it('asks instead of guessing when two machines fit equally', () => {
    const twin = device('TWIN', SURFACE, [QWEN35, CODER])
    expect(matchDevice([surface, twin], { hardware: SURFACE, digests: [QWEN35, CODER] })).toBeNull()
  })

  it('separates identical laptops by their models', () => {
    const twin = device('TWIN', SURFACE, [LLAMA])
    expect(matchDevice([surface, twin], { hardware: SURFACE, digests: [LLAMA] })?.id).toBe('TWIN')
  })
})

describe('naming a machine the browser cannot name', () => {
  it('uses the OS and the card', () => {
    expect(guessName(SURFACE)).toBe('Windows · Intel Iris Xe Graphics')
    expect(guessName({ os: 'macOS', cores: 10 })).toBe('macOS · 10 núcleos')
    expect(guessName({})).toBe('Computador')
  })

  it('keeps names unique', () => {
    expect(uniqueName('Windows', [])).toBe('Windows')
    expect(uniqueName('Windows', ['windows', 'Windows (2)'])).toBe('Windows (3)')
  })
})
