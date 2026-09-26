import type { ParseResult } from '../domain/types'
import { looksLikeBcpCsv, parseBcpCsv } from './bcpCsv'
import { looksLikeBcpPdf, parseBcpPdf } from './bcpPdf'
import { looksLikeItauPdf, parseItauPdf } from './itauPdf'
import { looksLikeItauCardXlsx, parseItauCardXlsx, type Cell } from './itauCardXlsx'
import { looksLikeMillenniumPdf, looksLikeMillenniumReceipt, parseMillenniumPdf } from './millenniumPdf'
import { pdfToLines, type PdfLoader } from './pdfText'

/** Reads the first sheet of an .xlsx; injected so tests and the browser can supply their own. */
export type XlsxLoader = (bytes: Uint8Array) => Promise<Cell[][]>

const defaultXlsx: XlsxLoader = async (bytes) => {
  const { readSheet } = await import('read-excel-file/universal') // loaded only for .xlsx
  return (await readSheet(bytes.slice().buffer)) as Cell[][]
}

const ignored = (warning: string): ParseResult => ({ source: 'ignored', transactions: [], checkpoints: [], warnings: [warning] })

/** Detects the file format and parses it. Throws on unsupported files. */
export async function parseStatement(fileName: string, bytes: Uint8Array, loadPdf: PdfLoader, loadXlsx: XlsxLoader = defaultXlsx): Promise<ParseResult> {
  if (/\.pdf$/i.test(fileName)) {
    const lines = await pdfToLines(bytes, loadPdf)
    if (looksLikeItauPdf(lines)) return parseItauPdf(lines)
    if (looksLikeBcpPdf(lines)) return parseBcpPdf(lines)
    if (looksLikeMillenniumPdf(lines)) return parseMillenniumPdf(lines)
    if (looksLikeMillenniumReceipt(lines)) return ignored('Comprovante Millennium: a operação já vem no extrato combinado — ignorado.')
    if (lines.some((l) => /Resumo da fatura em R\$/.test(l)))
      throw new Error(`${fileName}: fatura do cartão Itaú em PDF não é lida — exporte a fatura em Excel (.xlsx) no app/site Itaú`)
    throw new Error(`${fileName}: PDF não reconhecido (esperado extrato Itaú, relevé BCP ou extrato combinado Millennium)`)
  }
  if (/\.xlsx$/i.test(fileName)) {
    const rows = await loadXlsx(bytes)
    if (looksLikeItauCardXlsx(rows)) return parseItauCardXlsx(rows)
    throw new Error(`${fileName}: planilha não reconhecida (esperada fatura do cartão Itaú)`)
  }
  if (/\.csv$/i.test(fileName)) {
    // BCP exports are ISO-8859-1; try UTF-8 first and fall back.
    let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    if (text.includes('�')) text = new TextDecoder('iso-8859-1').decode(bytes)
    if (looksLikeBcpCsv(text)) return parseBcpCsv(text, fileName.split(/[\\/]/).pop() ?? fileName)
    throw new Error(`${fileName}: layout de CSV não reconhecido`)
  }
  throw new Error(`${fileName}: só .pdf, .csv e .xlsx são aceitos`)
}
