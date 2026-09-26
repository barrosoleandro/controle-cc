import type { ParseResult } from '../domain/types'
import { looksLikeBcpCsv, parseBcpCsv } from './bcpCsv'
import { looksLikeBcpPdf, parseBcpPdf } from './bcpPdf'
import { looksLikeItauPdf, parseItauPdf } from './itauPdf'
import { pdfToLines, type PdfLoader } from './pdfText'

/** Detects the file format and parses it. Throws on unsupported files. */
export async function parseStatement(fileName: string, bytes: Uint8Array, loadPdf: PdfLoader): Promise<ParseResult> {
  if (/\.pdf$/i.test(fileName)) {
    const lines = await pdfToLines(bytes, loadPdf)
    if (looksLikeItauPdf(lines)) return parseItauPdf(lines)
    if (looksLikeBcpPdf(lines)) return parseBcpPdf(lines)
    throw new Error(`${fileName}: unsupported PDF (not an Itaú extrato nor a BCP relevé)`)
  }
  if (/\.csv$/i.test(fileName)) {
    // BCP exports are ISO-8859-1; try UTF-8 first and fall back.
    let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    if (text.includes('�')) text = new TextDecoder('iso-8859-1').decode(bytes)
    if (looksLikeBcpCsv(text)) return parseBcpCsv(text, fileName.split(/[\\/]/).pop() ?? fileName)
    throw new Error(`${fileName}: unsupported CSV layout`)
  }
  throw new Error(`${fileName}: only .pdf and .csv are supported`)
}
