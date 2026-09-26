/**
 * Extracts a PDF into text lines, preserving column gaps as runs of spaces.
 * The pdf.js loader is injected so the same code runs in the browser and in Node.
 */
export interface PdfTextItem { str: string; transform: number[]; width: number }
export interface PdfLoader {
  (data: Uint8Array): Promise<{
    numPages: number
    getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }>
  }>
}

export async function pdfToLines(data: Uint8Array, load: PdfLoader): Promise<string[]> {
  const doc = await load(data)
  const out: string[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    const items = (content.items as PdfTextItem[]).filter((i) => typeof i.str === 'string' && i.str.trim() !== '')
    // Group by baseline (y), tolerant to 2pt jitter.
    const rows: { y: number; items: PdfTextItem[] }[] = []
    for (const it of items) {
      const y = it.transform[5]
      const row = rows.find((r) => Math.abs(r.y - y) < 2)
      if (row) row.items.push(it)
      else rows.push({ y, items: [it] })
    }
    rows.sort((a, b) => b.y - a.y)
    for (const row of rows) {
      row.items.sort((a, b) => a.transform[4] - b.transform[4])
      let line = ''
      let lastEnd: number | null = null
      for (const it of row.items) {
        const x = it.transform[4]
        if (lastEnd !== null) line += x - lastEnd > 6 ? '   ' : x - lastEnd > 0.5 ? ' ' : ''
        line += it.str
        lastEnd = x + it.width
      }
      out.push(line.replace(/\s+$/, ''))
    }
  }
  return out
}
