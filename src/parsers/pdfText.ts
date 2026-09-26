/**
 * Extracts a PDF into text rows. `pdfToRows` keeps x positions (needed for column layouts
 * such as payslips); `pdfToLines` flattens rows into strings, preserving column gaps as spaces.
 * The pdf.js loader is injected so the same code runs in the browser and in Node.
 */
export interface PdfTextItem { str: string; transform: number[]; width: number }
export interface PdfLoader {
  (data: Uint8Array): Promise<{
    numPages: number
    getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }>
  }>
}

/** One text item with its horizontal extent (PDF points). */
export interface Cell { x0: number; x1: number; str: string }
/** One visual row of a page, top to bottom. */
export interface Row { y: number; cells: Cell[] }

export async function pdfToRows(data: Uint8Array, load: PdfLoader): Promise<Row[][]> {
  const doc = await load(data)
  const pages: Row[][] = []
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
    pages.push(rows.map((r) => ({
      y: r.y,
      cells: r.items.sort((a, b) => a.transform[4] - b.transform[4])
        .map((it) => ({ x0: it.transform[4], x1: it.transform[4] + it.width, str: it.str })),
    })))
  }
  return pages
}

export async function pdfToLines(data: Uint8Array, load: PdfLoader): Promise<string[]> {
  const out: string[] = []
  for (const page of await pdfToRows(data, load)) {
    for (const row of page) {
      let line = ''
      let lastEnd: number | null = null
      for (const c of row.cells) {
        if (lastEnd !== null) line += c.x0 - lastEnd > 6 ? '   ' : c.x0 - lastEnd > 0.5 ? ' ' : ''
        line += c.str
        lastEnd = c.x1
      }
      out.push(line.replace(/\s+$/, ''))
    }
  }
  return out
}
