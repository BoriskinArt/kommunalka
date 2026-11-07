// Извлечение текста с координатами из PDF (PDF.js) и изображений (Tesseract OCR).

/** Преобразует textContent PDF.js во фрагменты с координатами «сверху вниз». */
export function pdfTextToItems(textContent, pageHeight) {
  const items = [];
  for (const it of textContent.items) {
    if (!it.str || !it.str.trim()) continue;
    const [a, b, , d, e, f] = it.transform;
    const h = Math.hypot(b, d) || it.height || 7;
    if (Math.abs(b) > Math.abs(a) * 0.2) continue; // повёрнутый текст (штампы, вертикальные надписи)
    items.push({ str: it.str, x: e, y: pageHeight - f - h, w: it.width, h });
  }
  return items;
}

let pdfjsPromise = null;
function loadPdfJs() {
  pdfjsPromise ??= import('../vendor/pdfjs/pdf.min.mjs').then((m) => {
    m.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
    return m;
  });
  return pdfjsPromise;
}

/**
 * Читает PDF. Страницы без текстового слоя (сканы) рендерятся в canvas для OCR.
 * @returns {Promise<{pages: Array, scannedCanvases: HTMLCanvasElement[]}>}
 */
export async function readPdf(file, { forceOcr = false, onProgress } = {}) {
  const pdfjs = await loadPdfJs();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const pages = [];
  const scannedCanvases = [];
  for (let p = 1; p <= doc.numPages; p++) {
    onProgress?.(`Чтение страницы ${p} из ${doc.numPages}…`);
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = pdfTextToItems(tc, vp.height);
    const textLen = items.reduce((s, i) => s + i.str.trim().length, 0);
    if (!forceOcr && textLen > 80) {
      pages.push({ items, source: 'pdf' });
    } else {
      const scale = Math.min(4, 2600 / vp.width);
      const v2 = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(v2.width);
      canvas.height = Math.round(v2.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: v2 }).promise;
      scannedCanvases.push(canvas);
    }
  }
  return { pages, scannedCanvases };
}

let workerPromise = null;
async function getOcrWorker(onProgress) {
  if (!workerPromise) {
    workerPromise = (async () => {
      if (!window.Tesseract) {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = new URL('../vendor/tesseract/tesseract.min.js', import.meta.url).href;
          s.onload = resolve;
          s.onerror = () => reject(new Error('Не удалось загрузить модуль OCR'));
          document.head.appendChild(s);
        });
      }
      const base = new URL('../vendor/tesseract/', import.meta.url).href;
      const worker = await window.Tesseract.createWorker('rus', 1, {
        workerPath: base + 'worker.min.js',
        corePath: base,
        langPath: base + 'lang',
        gzip: true,
        logger: (m) => {
          if (m.status === 'recognizing text') onProgressRef.fn?.(`Распознавание текста… ${Math.round(m.progress * 100)}%`);
          else if (m.status) onProgressRef.fn?.('Подготовка распознавания…');
        },
      });
      await worker.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300' });
      return worker;
    })();
    workerPromise.catch(() => { workerPromise = null; });
  }
  onProgressRef.fn = onProgress;
  return workerPromise;
}
const onProgressRef = { fn: null };

/** OCR одного canvas → фрагменты-слова с координатами и уверенностью. */
export async function ocrCanvas(canvas, { onProgress, psm = '3' } = {}) {
  const worker = await getOcrWorker(onProgress);
  await worker.setParameters({ tessedit_pageseg_mode: psm });
  const { data } = await worker.recognize(canvas);
  return ocrWordsToItems(data.words || []);
}

export function ocrWordsToItems(words) {
  return words
    .filter((w) => w.text && w.text.trim())
    .map((w) => ({
      str: w.text.trim(),
      x: w.bbox.x0,
      y: w.bbox.y0,
      w: w.bbox.x1 - w.bbox.x0,
      h: w.bbox.y1 - w.bbox.y0,
      conf: w.confidence,
    }));
}
