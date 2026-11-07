// Подготовка фотографии квитанции: поворот, рамка по 4 углам (обрезка + исправление перспективы),
// увеличение мелкого текста, повышение контраста.

export async function loadImage(file) {
  const isHeic = /hei[cf]$/i.test(file.name) || /hei[cf]/i.test(file.type);
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    try {
      const url = URL.createObjectURL(file);
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = rej;
        i.src = url;
      });
      URL.revokeObjectURL(url);
      return img;
    } catch {
      throw new Error(isHeic
        ? 'Этот браузер не открывает HEIC. Сохраните фото как JPG или сделайте скриншот и загрузите снова.'
        : `Не удалось открыть изображение «${file.name}».`);
    }
  }
}

function toCanvas(img) {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d').drawImage(img, 0, 0);
  return c;
}

export class PhotoEditor {
  constructor(canvasEl) {
    this.view = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this.src = null;
    this.corners = null;
    this.contrast = true;
    this.drag = -1;
    canvasEl.addEventListener('pointerdown', (e) => this.onDown(e));
    canvasEl.addEventListener('pointermove', (e) => this.onMove(e));
    const up = () => { this.drag = -1; };
    canvasEl.addEventListener('pointerup', up);
    canvasEl.addEventListener('pointercancel', up);
    window.addEventListener('resize', () => this.src && this.draw());
  }

  setImage(img) {
    this.src = toCanvas(img);
    this.resetFrame();
  }

  resetFrame() {
    const { width: w, height: h } = this.src;
    const m = 0.02;
    this.corners = [[w * m, h * m], [w * (1 - m), h * m], [w * (1 - m), h * (1 - m)], [w * m, h * (1 - m)]];
    this.draw();
  }

  rotate(dir) {
    const s = this.src;
    const c = document.createElement('canvas');
    c.width = s.height;
    c.height = s.width;
    const x = c.getContext('2d');
    x.translate(c.width / 2, c.height / 2);
    x.rotate((dir * Math.PI) / 2);
    x.drawImage(s, -s.width / 2, -s.height / 2);
    this.src = c;
    this.resetFrame();
  }

  get scale() {
    return this.view.width / this.src.width;
  }

  draw() {
    const dpr = window.devicePixelRatio || 1;
    const cssW = this.view.clientWidth || 320;
    const maxH = window.innerHeight * 0.6;
    let w = cssW;
    let h = (w * this.src.height) / this.src.width;
    if (h > maxH) { h = maxH; w = (h * this.src.width) / this.src.height; }
    this.view.style.height = `${h}px`;
    this.view.style.width = `${w}px`;
    this.view.width = Math.round(w * dpr);
    this.view.height = Math.round(h * dpr);
    const k = this.scale;
    const ctx = this.ctx;
    ctx.drawImage(this.src, 0, 0, this.view.width, this.view.height);
    const pts = this.corners.map(([x, y]) => [x * k, y * k]);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.rect(0, 0, this.view.width, this.view.height);
    ctx.moveTo(...pts[0]);
    for (const p of [pts[3], pts[2], pts[1]]) ctx.lineTo(...p);
    ctx.closePath();
    ctx.fill('evenodd');
    ctx.strokeStyle = '#1aa36f';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(...pts[0]);
    for (const p of pts.slice(1)) ctx.lineTo(...p);
    ctx.closePath();
    ctx.stroke();
    for (const [x, y] of pts) {
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(x, y, 11 * dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  pointerToSrc(e) {
    const r = this.view.getBoundingClientRect();
    const k = this.src.width / r.width;
    return [(e.clientX - r.left) * k, (e.clientY - r.top) * k, k];
  }

  onDown(e) {
    if (!this.src) return;
    const [x, y, k] = this.pointerToSrc(e);
    let best = -1;
    let bd = 40 * k;
    this.corners.forEach(([cx, cy], i) => {
      const d = Math.hypot(cx - x, cy - y);
      if (d < bd) { bd = d; best = i; }
    });
    this.drag = best;
    if (best >= 0) this.view.setPointerCapture(e.pointerId);
  }

  onMove(e) {
    if (this.drag < 0) return;
    const [x, y] = this.pointerToSrc(e);
    this.corners[this.drag] = [Math.max(0, Math.min(this.src.width, x)), Math.max(0, Math.min(this.src.height, y))];
    this.draw();
  }

  /** Возвращает canvas для OCR: выпрямленный, увеличенный, контрастный. */
  render() {
    const [tl, tr, br, bl] = this.corners;
    const wTop = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]);
    const wBot = Math.hypot(br[0] - bl[0], br[1] - bl[1]);
    const hL = Math.hypot(bl[0] - tl[0], bl[1] - tl[1]);
    const hR = Math.hypot(br[0] - tr[0], br[1] - tr[1]);
    let W = Math.max(wTop, wBot);
    let H = Math.max(hL, hR);
    // Мелкий текст: увеличиваем до ширины ≥ 2000 px, но не больше ~9 Мпикс.
    let up = Math.max(1, 2000 / W);
    if (W * H * up * up > 9e6) up = Math.sqrt(9e6 / (W * H));
    W = Math.round(W * up);
    H = Math.round(H * up);
    const out = warpPerspective(this.src, this.corners, W, H);
    enhance(out, this.contrast);
    return out;
  }
}

// Решение 8×8 системы для гомографии: единичный квадрат → четырёхугольник.
function homography(dst) {
  const src = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  return b.map((v, i) => v / A[i][i]);
}

function warpPerspective(srcCanvas, corners, W, H) {
  const [a, b, c, d, e, f, g, h] = homography(corners);
  const sw = srcCanvas.width;
  const sh = srcCanvas.height;
  const sdata = srcCanvas.getContext('2d').getImageData(0, 0, sw, sh).data;
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const octx = out.getContext('2d');
  const img = octx.createImageData(W, H);
  const o = img.data;
  for (let j = 0; j < H; j++) {
    const y = (j + 0.5) / H;
    for (let i = 0; i < W; i++) {
      const x = (i + 0.5) / W;
      const den = g * x + h * y + 1;
      const u = (a * x + b * y + c) / den - 0.5;
      const v = (d * x + e * y + f) / den - 0.5;
      const x0 = Math.max(0, Math.min(sw - 2, Math.floor(u)));
      const y0 = Math.max(0, Math.min(sh - 2, Math.floor(v)));
      const fx = Math.max(0, Math.min(1, u - x0));
      const fy = Math.max(0, Math.min(1, v - y0));
      const p00 = (y0 * sw + x0) * 4;
      const p10 = p00 + 4;
      const p01 = p00 + sw * 4;
      const p11 = p01 + 4;
      const q = (j * W + i) * 4;
      for (let ch = 0; ch < 3; ch++) {
        o[q + ch] = (sdata[p00 + ch] * (1 - fx) + sdata[p10 + ch] * fx) * (1 - fy)
          + (sdata[p01 + ch] * (1 - fx) + sdata[p11 + ch] * fx) * fy;
      }
      o[q + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

/** Оттенки серого + растяжение уровней (2–98 перцентиль). Тёмный текст на светлом фоне. */
function enhance(canvas, strong) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const l = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    d[i] = l;
    hist[l | 0]++;
  }
  const n = d.length / 4;
  let lo = 0;
  let hi = 255;
  for (let acc = 0, v = 0; v < 256; v++) { acc += hist[v]; if (acc > n * 0.02) { lo = v; break; } }
  for (let acc = 0, v = 255; v >= 0; v--) { acc += hist[v]; if (acc > n * 0.02) { hi = v; break; } }
  if (hi - lo < 30) { lo = 0; hi = 255; }
  // Светлый текст на тёмном фоне (тёмная тема приложения) — инвертируем.
  let mean = 0;
  for (let v = 0; v < 256; v++) mean += v * hist[v];
  const invert = mean / n < 110;
  const gamma = strong ? 1.6 : 1;
  for (let i = 0; i < d.length; i += 4) {
    let t = (d[i] - lo) / (hi - lo);
    t = Math.max(0, Math.min(1, t));
    if (invert) t = 1 - t;
    t = Math.pow(t, gamma);
    const v = t * 255;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
}
