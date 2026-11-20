// Legacy build: the modern one needs very recent JS (iterator helpers, Map.getOrInsertComputed,
// Math.sumPrecise) and fails on older Safari/iOS with "undefined is not a function".
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import type { PdfLoader } from '../parsers/pdfText'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
export const loadPdf: PdfLoader = (data) => pdfjs.getDocument({ data }).promise as never
