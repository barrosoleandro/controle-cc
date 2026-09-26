import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PdfLoader } from '../parsers/pdfText'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
export const loadPdf: PdfLoader = (data) => pdfjs.getDocument({ data }).promise as never
