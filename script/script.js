  // ========================
    // Image Converter
    // ========================

    const $ = (id) => document.getElementById(id);

    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

    const presetButtons = document.querySelectorAll("[data-preset]");

    function setActivePreset(key){
  presetButtons.forEach(b => {
    b.classList.toggle(
      "preset-active",
      b.getAttribute("data-preset") === key
    );
  });
}


    const fmtBytes = (bytes) => {
      if (!Number.isFinite(bytes)) return "-";
      const kb = bytes / 1024;
      if (kb < 1024) return `${kb.toFixed(1)} KB`;
      return `${(kb / 1024).toFixed(2)} MB`;
    };

    const debounce = (fn, ms) => {
      let t = null;
      return (...args) => {
        if (t) clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
      };
    };

    // ========================
    // UI refs
    // ========================

    const ui = {
      tabBasic: $("tabBasic"),
      tabAdvanced: $("tabAdvanced"),
      basicPane: $("basicPane"),
      advancedPane: $("advancedPane"),

      file: $("file"),
      download: $("download"),

      quality: $("quality"),
      scale: $("scale"),

      bw: $("bw"),
      mode: $("mode"),
      bits: $("bits"),
      bitsNum: $("bitsNum"),
      palette: $("palette"),
      paletteNum: $("paletteNum"),
      ditherType: $("ditherType"),
      ditherStrength: $("ditherStrength"),
      blockSize: $("blockSize"),
      blockStrength: $("blockStrength"),

      bitsBlock: $("bitsBlock"),
      paletteBlock: $("paletteBlock"),

      qualityVal: $("qualityVal"),
      scaleVal: $("scaleVal"),
      ditherVal: $("ditherVal"),
      blockVal: $("blockVal"),
      blockStrVal: $("blockStrVal"),

      bigQ: $("bigQ"),
      bigS: $("bigS"),
      bigP: $("bigP"),
      bigE: $("bigE"),
      bigBefore: $("bigBefore"),
      bigAfter: $("bigAfter"),
      bigReduct: $("bigReduct"),
      bigMs: $("bigMs"),

      previewCapNote: $("previewCapNote"),
      canvasHost: $("canvasHost"),
    };

    // ========================
    // Tabs
    // ========================

    function setTab(which) {
      const basic = which === "basic";
      ui.tabBasic.setAttribute("aria-selected", String(basic));
      ui.tabAdvanced.setAttribute("aria-selected", String(!basic));
      ui.basicPane.classList.toggle("hidden", !basic);
      ui.advancedPane.classList.toggle("hidden", basic);
    }
    ui.tabBasic.addEventListener("click", () => setTab("basic"));
    ui.tabAdvanced.addEventListener("click", () => setTab("advanced"));

    // ========================
    // Range <-> Number helper
    // ========================

    function bindRangeNumber(rangeEl, numEl, onChange) {
      const min = parseInt(rangeEl.min, 10);
      const max = parseInt(rangeEl.max, 10);
      const step = parseInt(rangeEl.step || "1", 10);

      const syncFromRange = () => {
        numEl.value = rangeEl.value;
        onChange();
      };

      const syncFromNum = () => {
        let v = parseInt(numEl.value, 10);
        if (!Number.isFinite(v)) v = min;
        v = clamp(v, min, max);
        v = Math.round((v - min) / step) * step + min;
        rangeEl.value = String(v);
        numEl.value = String(v);
        onChange();
      };

      rangeEl.addEventListener("input", syncFromRange);
      rangeEl.addEventListener("change", syncFromRange);
      numEl.addEventListener("input", syncFromNum);
      numEl.addEventListener("change", syncFromNum);
      numEl.addEventListener("blur", syncFromNum);
    }

    // ========================
    // Settings + UI sync
    // ========================

    const PREVIEW_CAP_PIXELS = 1_200_000;
    const PALETTE_SAMPLE_FIXED = 4096;
    const LIVE_ENCODE_DEBOUNCE = 220;

    function syncModeBlocks() {
      const m = ui.mode.value;
      ui.bitsBlock.classList.toggle("hidden", m !== "bits");
      ui.paletteBlock.classList.toggle("hidden", m !== "palette");
    }
    ui.mode.addEventListener("change", () => {
      syncModeBlocks();
      syncUI();
      requestRender(true);
    });
    syncModeBlocks();

    function syncUI() {
      ui.qualityVal.textContent = ui.quality.value;
      ui.scaleVal.textContent = ui.scale.value;
      ui.ditherVal.textContent = ui.ditherStrength.value;
      ui.blockVal.textContent = ui.blockSize.value;
      ui.blockStrVal.textContent = ui.blockStrength.value;

      ui.bigQ.textContent = ui.quality.value;
      ui.bigS.textContent = ui.scale.value;
    }

    function getSettings() {
      return {
        mime: "image/jpeg",
        quality: clamp(parseInt(ui.quality.value, 10) / 100, 0.05, 0.95),
        scale: clamp(parseInt(ui.scale.value, 10) / 100, 0.10, 1.00),

        bw: ui.bw.checked,
        mode: ui.mode.value, // bits | palette
        bits: clamp(parseInt(ui.bits.value, 10), 1, 8),
        paletteN: clamp(parseInt(ui.palette.value, 10), 2, 256),

        ditherType: ui.ditherType.value, // none | fs | ordered8 | random
        ditherStrength: clamp(parseInt(ui.ditherStrength.value, 10) / 100, 0, 1),

        blockSize: clamp(parseInt(ui.blockSize.value, 10), 1, 32),
        blockStrength: clamp(parseInt(ui.blockStrength.value, 10) / 100, 0, 1),
      };
    }

    bindRangeNumber(ui.bits, ui.bitsNum, () => { syncUI(); requestRender(); });
    bindRangeNumber(ui.palette, ui.paletteNum, () => { syncUI(); requestRender(true); });

    // ========================
    // Image state + caches
    // ========================

    let srcImg = null;
    let srcBytes = NaN;
    let srcName = "image";

    let cacheKey = "";
    let stage1 = null;
    let stage2 = null;

    let paletteCache = null;
    let paletteKey = "";

    let lastExportBlob = null;
    let lastExportW = 0;
    let lastExportH = 0;
    let lastRenderMs = 0;

    // ========================
    // Canvas helpers
    // ========================

    const makeCanvas = (w, h) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      return c;
    };

    const canvasToBlob = (canvasEl, mime, quality) =>
      new Promise((resolve) => canvasEl.toBlob((blob) => resolve(blob), mime, quality));

    function imgToImageData(img, w, h) {
      const c = makeCanvas(w, h);
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img.canvas ? img.canvas : img.elt || img, 0, 0, w, h);
      return ctx.getImageData(0, 0, w, h);
    }

    function putImageData(imageData, canvas) {
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.putImageData(imageData, 0, 0);
    }

    // ========================
    // Pipeline ops
    // ========================

    function applyBlockMixRGBA(data, w, h, blockSize, strength) {
      if (strength <= 0 || blockSize <= 1) return;
      const bs = blockSize;

      for (let by = 0; by < h; by += bs) {
        for (let bx = 0; bx < w; bx += bs) {
          let sr = 0, sg = 0, sb = 0, cnt = 0;
          const yMax = Math.min(h, by + bs);
          const xMax = Math.min(w, bx + bs);

          for (let y = by; y < yMax; y++) {
            for (let x = bx; x < xMax; x++) {
              const p = (y * w + x) * 4;
              sr += data[p];
              sg += data[p + 1];
              sb += data[p + 2];
              cnt++;
            }
          }

          const ar = sr / cnt, ag = sg / cnt, ab = sb / cnt;

          for (let y = by; y < yMax; y++) {
            for (let x = bx; x < xMax; x++) {
              const p = (y * w + x) * 4;
              data[p]     = Math.round(data[p]     + (ar - data[p])     * strength);
              data[p + 1] = Math.round(data[p + 1] + (ag - data[p + 1]) * strength);
              data[p + 2] = Math.round(data[p + 2] + (ab - data[p + 2]) * strength);
            }
          }
        }
      }
    }

    function applyBWRGBA(data) {
      for (let p = 0; p < data.length; p += 4) {
        const r = data[p], g = data[p + 1], b = data[p + 2];
        const y = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        data[p] = data[p + 1] = data[p + 2] = y;
      }
    }

    const quantizeToBits = (v, bits) => {
      const levels = (1 << bits);
      const step = 255 / (levels - 1);
      return Math.round(v / step) * step;
    };

    // Median Cut Palette
    function buildMedianCutPalette(imageData, paletteN, sampleCount) {
      const data = imageData.data;
      const nPixels = imageData.width * imageData.height;
      const take = Math.min(sampleCount, nPixels);

      const samples = new Uint8Array(take * 3);
      const stride = Math.max(1, Math.floor(nPixels / take));

      let si = 0;
      for (let i = 0; i < nPixels && si < take; i += stride) {
        const p = i * 4;
        samples[si * 3] = data[p];
        samples[si * 3 + 1] = data[p + 1];
        samples[si * 3 + 2] = data[p + 2];
        si++;
      }

      const makeBox = (start, end) => {
        let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
        for (let i = start; i < end; i++) {
          const r = samples[i * 3], g = samples[i * 3 + 1], b = samples[i * 3 + 2];
          if (r < rMin) rMin = r; if (r > rMax) rMax = r;
          if (g < gMin) gMin = g; if (g > gMax) gMax = g;
          if (b < bMin) bMin = b; if (b > bMax) bMax = b;
        }
        return { start, end, rMin, rMax, gMin, gMax, bMin, bMax };
      };

      const longestChannel = (box) => {
        const r = box.rMax - box.rMin;
        const g = box.gMax - box.gMin;
        const b = box.bMax - box.bMin;
        if (r >= g && r >= b) return 0;
        if (g >= r && g >= b) return 1;
        return 2;
      };

      let boxes = [makeBox(0, si)];

      while (boxes.length < paletteN) {
        let best = -1, bestRange = -1;

        for (let i = 0; i < boxes.length; i++) {
          const box = boxes[i];
          if (box.end - box.start < 2) continue;
          const r = box.rMax - box.rMin;
          const g = box.gMax - box.gMin;
          const b = box.bMax - box.bMin;
          const m = Math.max(r, g, b);
          if (m > bestRange) { bestRange = m; best = i; }
        }

        if (best === -1) break;

        const box = boxes[best];
        const ch = longestChannel(box);
        const start = box.start, end = box.end;

        // sort samples slice by channel ch
        const idx = new Uint32Array(end - start);
        for (let i = 0; i < idx.length; i++) idx[i] = start + i;
        idx.sort((a, b) => samples[a * 3 + ch] - samples[b * 3 + ch]);

        // write sorted slice back
        const tmp = new Uint8Array((end - start) * 3);
        for (let i = 0; i < idx.length; i++) {
          const s = idx[i] * 3;
          const d = i * 3;
          tmp[d] = samples[s];
          tmp[d + 1] = samples[s + 1];
          tmp[d + 2] = samples[s + 2];
        }
        for (let i = 0; i < idx.length; i++) {
          const d = (start + i) * 3;
          const s = i * 3;
          samples[d] = tmp[s];
          samples[d + 1] = tmp[s + 1];
          samples[d + 2] = tmp[s + 2];
        }

        const mid = start + Math.floor((end - start) / 2);
        boxes.splice(best, 1, makeBox(start, mid), makeBox(mid, end));
      }

      const palette = new Uint8Array(boxes.length * 3);
      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i];
        let sr = 0, sg = 0, sb = 0, cnt = 0;
        for (let j = box.start; j < box.end; j++) {
          sr += samples[j * 3];
          sg += samples[j * 3 + 1];
          sb += samples[j * 3 + 2];
          cnt++;
        }
        palette[i * 3] = cnt ? Math.round(sr / cnt) : 0;
        palette[i * 3 + 1] = cnt ? Math.round(sg / cnt) : 0;
        palette[i * 3 + 2] = cnt ? Math.round(sb / cnt) : 0;
      }

      return palette;
    }

    function nearestPaletteColor(r, g, b, palette) {
      let best = 0;
      let bestD = 1e18;
      for (let i = 0; i < palette.length; i += 3) {
        const dr = r - palette[i];
        const dg = g - palette[i + 1];
        const db = b - palette[i + 2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) { bestD = d; best = i; }
      }
      return [palette[best], palette[best + 1], palette[best + 2]];
    }

    const BAYER8 = [
      [0,48,12,60,3,51,15,63],
      [32,16,44,28,35,19,47,31],
      [8,56,4,52,11,59,7,55],
      [40,24,36,20,43,27,39,23],
      [2,50,14,62,1,49,13,61],
      [34,18,46,30,33,17,45,29],
      [10,58,6,54,9,57,5,53],
      [42,26,38,22,41,25,37,21]
    ];

    function applyQuantPaletteWithDither(imageData, s, palette) {
      const { width: w, height: h, data } = imageData;
      const type = s.ditherType;
      const strength = s.ditherStrength;
      const doBits = s.mode === "bits";

      // Fast path
      if (type === "none" || strength <= 0) {
        if (doBits) {
          for (let p = 0; p < data.length; p += 4) {
            if (s.bw) {
              const q = quantizeToBits(data[p], s.bits);
              const v = clamp(Math.round(q), 0, 255);
              data[p] = data[p + 1] = data[p + 2] = v;
            } else {
              data[p]     = clamp(Math.round(quantizeToBits(data[p],     s.bits)), 0, 255);
              data[p + 1] = clamp(Math.round(quantizeToBits(data[p + 1], s.bits)), 0, 255);
              data[p + 2] = clamp(Math.round(quantizeToBits(data[p + 2], s.bits)), 0, 255);
            }
          }
          return;
        }

        for (let p = 0; p < data.length; p += 4) {
          const c = nearestPaletteColor(data[p], data[p + 1], data[p + 2], palette);
          data[p] = c[0]; data[p + 1] = c[1]; data[p + 2] = c[2];
        }
        return;
      }

      if (type === "ordered8") {
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const p = (y * w + x) * 4;
            const t = (BAYER8[y & 7][x & 7] / 63) - 0.5;
            const amt = t * 64 * strength;

            if (doBits) {
              if (s.bw) {
                const v = clamp(data[p] + amt, 0, 255);
                const q = quantizeToBits(v, s.bits);
                const out = clamp(Math.round(q), 0, 255);
                data[p] = data[p + 1] = data[p + 2] = out;
              } else {
                data[p]     = clamp(Math.round(quantizeToBits(clamp(data[p]     + amt, 0, 255), s.bits)), 0, 255);
                data[p + 1] = clamp(Math.round(quantizeToBits(clamp(data[p + 1] + amt, 0, 255), s.bits)), 0, 255);
                data[p + 2] = clamp(Math.round(quantizeToBits(clamp(data[p + 2] + amt, 0, 255), s.bits)), 0, 255);
              }
            } else {
              const rr = clamp(data[p]     + amt, 0, 255);
              const gg = clamp(data[p + 1] + amt, 0, 255);
              const bb = clamp(data[p + 2] + amt, 0, 255);
              const c = nearestPaletteColor(rr, gg, bb, palette);
              data[p] = c[0]; data[p + 1] = c[1]; data[p + 2] = c[2];
            }
          }
        }
        return;
      }

      if (type === "random") {
        for (let p = 0; p < data.length; p += 4) {
          const n = (Math.random() - 0.5) * 64 * strength;
          if (doBits) {
            if (s.bw) {
              const v = clamp(data[p] + n, 0, 255);
              const q = quantizeToBits(v, s.bits);
              const out = clamp(Math.round(q), 0, 255);
              data[p] = data[p + 1] = data[p + 2] = out;
            } else {
              data[p]     = clamp(Math.round(quantizeToBits(clamp(data[p]     + n, 0, 255), s.bits)), 0, 255);
              data[p + 1] = clamp(Math.round(quantizeToBits(clamp(data[p + 1] + n, 0, 255), s.bits)), 0, 255);
              data[p + 2] = clamp(Math.round(quantizeToBits(clamp(data[p + 2] + n, 0, 255), s.bits)), 0, 255);
            }
          } else {
            const rr = clamp(data[p]     + n, 0, 255);
            const gg = clamp(data[p + 1] + n, 0, 255);
            const bb = clamp(data[p + 2] + n, 0, 255);
            const c = nearestPaletteColor(rr, gg, bb, palette);
            data[p] = c[0]; data[p + 1] = c[1]; data[p + 2] = c[2];
          }
        }
        return;
      }

      // Floyd Steinberg
      const w1 = w + 1;
      const er = new Float32Array(w1 * (h + 1));
      const eg = new Float32Array(w1 * (h + 1));
      const eb = new Float32Array(w1 * (h + 1));

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = y * w1 + x;
          const p = (y * w + x) * 4;

          let r = clamp(data[p]     + er[idx], 0, 255);
          let g = clamp(data[p + 1] + eg[idx], 0, 255);
          let b = clamp(data[p + 2] + eb[idx], 0, 255);

          let outR = 0, outG = 0, outB = 0;

          if (doBits) {
            if (s.bw) {
              const q = quantizeToBits(r, s.bits);
              outR = outG = outB = clamp(Math.round(q), 0, 255);
            } else {
              outR = clamp(Math.round(quantizeToBits(r, s.bits)), 0, 255);
              outG = clamp(Math.round(quantizeToBits(g, s.bits)), 0, 255);
              outB = clamp(Math.round(quantizeToBits(b, s.bits)), 0, 255);
            }
          } else {
            const c = nearestPaletteColor(r, g, b, palette);
            outR = c[0]; outG = c[1]; outB = c[2];
          }

          data[p] = outR; data[p + 1] = outG; data[p + 2] = outB;

          const eR = (r - outR) * strength;
          const eG = (g - outG) * strength;
          const eB = (b - outB) * strength;

          er[idx + 1] += eR * 7 / 16; eg[idx + 1] += eG * 7 / 16; eb[idx + 1] += eB * 7 / 16;

          if (y + 1 < h) {
            const d = (y + 1) * w1 + x;
            if (x - 1 >= 0) {
              er[d - 1] += eR * 3 / 16; eg[d - 1] += eG * 3 / 16; eb[d - 1] += eB * 3 / 16;
            }
            er[d]     += eR * 5 / 16; eg[d]     += eG * 5 / 16; eb[d]     += eB * 5 / 16;
            er[d + 1] += eR * 1 / 16; eg[d + 1] += eG * 1 / 16; eb[d + 1] += eB * 1 / 16;
          }
        }
      }
    }

    // ========================
    // Dims, preview cap, palette cache
    // ========================

    const exportDims = (s) => ({
      w: Math.max(1, Math.round(srcImg.width * s.scale)),
      h: Math.max(1, Math.round(srcImg.height * s.scale)),
    });

    function previewDims(exportW, exportH) {
      const hostW = Math.max(1, ui.canvasHost.clientWidth - 8);
      const hostH = Math.max(1, ui.canvasHost.clientHeight - 8);

      const exportPx = exportW * exportH;
      let previewW = exportW;
      let previewH = exportH;
      let capped = false;

      if (exportPx > PREVIEW_CAP_PIXELS) {
        const ratio = Math.sqrt(PREVIEW_CAP_PIXELS / exportPx);
        previewW = Math.max(1, Math.round(exportW * ratio));
        previewH = Math.max(1, Math.round(exportH * ratio));
        capped = true;
      }

      const fit = Math.min(hostW / previewW, hostH / previewH, 6);
      const drawW = Math.max(1, Math.round(previewW * fit));
      const drawH = Math.max(1, Math.round(previewH * fit));

      return { previewW, previewH, drawW, drawH, capped };
    }

    function ensurePalette(s) {
      if (s.mode !== "palette") { paletteCache = null; paletteKey = ""; return; }
      const key = `${stage1.width}x${stage1.height}|n${s.paletteN}|fixed${PALETTE_SAMPLE_FIXED}|bw${s.bw ? 1 : 0}`;
      if (key === paletteKey && paletteCache) return;

      paletteCache = buildMedianCutPalette(stage1, s.paletteN, PALETTE_SAMPLE_FIXED);
      paletteKey = key;
    }

    function makeCacheKey(s, w, h) {
      // stabiler Key, ohne riesiges JSON aus allem möglichen außerhalb settings
      return `${w}x${h}|` + JSON.stringify({
        q: s.quality, sc: s.scale,
        bw: s.bw, m: s.mode, b: s.bits, pn: s.paletteN,
        dt: s.ditherType, ds: s.ditherStrength,
        ks: s.blockSize, kst: s.blockStrength,
      });
    }

    // ========================
    // Build pipeline for export size
    // ========================

    function buildPipeline(s, outW, outH) {
      const stage0 = imgToImageData(srcImg, outW, outH);

      stage1 = new ImageData(new Uint8ClampedArray(stage0.data), stage0.width, stage0.height);
      applyBlockMixRGBA(stage1.data, stage1.width, stage1.height, s.blockSize, s.blockStrength);
      if (s.bw) applyBWRGBA(stage1.data);

      stage2 = new ImageData(new Uint8ClampedArray(stage1.data), stage1.width, stage1.height);
      ensurePalette(s);
      applyQuantPaletteWithDither(stage2, s, paletteCache);
    }

    // ========================
    // Live encode (size estimate)
    // ========================

    const liveEncode = debounce(async () => {
      if (!srcImg || !stage2) return;
      const s = getSettings();

      const tmp = makeCanvas(stage2.width, stage2.height);
      putImageData(stage2, tmp);
      const blob = await canvasToBlob(tmp, s.mime, s.quality);

      lastExportBlob = blob;
      lastExportW = stage2.width;
      lastExportH = stage2.height;

      const exportText = blob ? fmtBytes(blob.size) : "-";
      ui.bigE.textContent = exportText;
      ui.bigAfter.textContent = `${stage2.width}x${stage2.height} ${exportText}`;

      if (Number.isFinite(srcBytes) && blob) {
        const red = 100 * (1 - blob.size / srcBytes);
        ui.bigReduct.textContent = `${red.toFixed(1)}%`;
      } else {
        ui.bigReduct.textContent = "-";
      }
    }, LIVE_ENCODE_DEBOUNCE);

    // ========================
    // p5 canvas setup + draw
    // ========================

    let p5Ready = false;

    function setup() {
      const cnv = createCanvas(640, 420);
      cnv.parent(ui.canvasHost);
      pixelDensity(1);
      noLoop();
      background(255);
      p5Ready = true;
    }
    function draw() {}

    function shouldNearestUpscale(s) {
      return (s.blockStrength >= 0.9 && s.blockSize >= 4);
    }

    function drawToP5(prev, s) {
      if (!p5Ready || !stage2) return;

      let previewData = stage2;

      if (prev.capped) {
        const srcC = makeCanvas(stage2.width, stage2.height);
        putImageData(stage2, srcC);

        const dstC = makeCanvas(prev.previewW, prev.previewH);
        const ctx = dstC.getContext("2d", { willReadFrequently: true });
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(srcC, 0, 0, prev.previewW, prev.previewH);
        previewData = ctx.getImageData(0, 0, prev.previewW, prev.previewH);
      }

      resizeCanvas(prev.drawW, prev.drawH, true);

      const tmp = makeCanvas(previewData.width, previewData.height);
      putImageData(previewData, tmp);

      clear();
      background(255);

      const nearest = shouldNearestUpscale(s);
      drawingContext.imageSmoothingEnabled = !nearest;
      drawingContext.imageSmoothingQuality = nearest ? "low" : "high";
      drawingContext.drawImage(tmp, 0, 0, width, height);
    }

    // ========================
    // Render orchestration
    // ========================

    const requestRender = debounce((forcePalette = false) => {
      if (!srcImg) return;

      const s = getSettings();
      syncUI();

      const t0 = performance.now();
      const { w: exportW, h: exportH } = exportDims(s);
      const key = makeCacheKey(s, exportW, exportH);

      if (key !== cacheKey) {
        cacheKey = key;
        paletteKey = "";
        buildPipeline(s, exportW, exportH);
      } else if (forcePalette) {
        stage2 = new ImageData(new Uint8ClampedArray(stage1.data), stage1.width, stage1.height);
        ensurePalette(s);
        applyQuantPaletteWithDither(stage2, s, paletteCache);
      }

      lastRenderMs = performance.now() - t0;
      ui.bigMs.textContent = String(Math.round(lastRenderMs));

      const prev = previewDims(stage2.width, stage2.height);
      ui.previewCapNote.textContent = prev.capped
        ? `Preview capped to ${prev.previewW}x${prev.previewH}. Export stays ${stage2.width}x${stage2.height}.`
        : "";

      drawToP5(prev, s);

      ui.bigP.textContent = `${prev.previewW}x${prev.previewH}`;
      liveEncode();
    }, 80);

    function onAnyChange(forcePalette = false) {
      syncUI();
      requestRender(forcePalette);
    }

    // Basic
    ui.quality.addEventListener("input", () => onAnyChange());
    ui.quality.addEventListener("change", () => onAnyChange());
    ui.scale.addEventListener("input", () => onAnyChange());
    ui.scale.addEventListener("change", () => onAnyChange());

    // Advanced
    ui.bw.addEventListener("change", () => onAnyChange(true));
    ui.ditherType.addEventListener("change", () => onAnyChange(true));
    ui.ditherStrength.addEventListener("input", () => onAnyChange(true));
    ui.ditherStrength.addEventListener("change", () => onAnyChange(true));
    ui.blockSize.addEventListener("input", () => onAnyChange());
    ui.blockSize.addEventListener("change", () => onAnyChange());
    ui.blockStrength.addEventListener("input", () => onAnyChange());
    ui.blockStrength.addEventListener("change", () => onAnyChange());

    // ========================
    // File load
    // ========================

    ui.file.addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;

      srcBytes = f.size;
      srcName = (f.name || "image").replace(/\.[^/.]+$/, "");

      ui.bigBefore.textContent = "loading...";
      ui.bigAfter.textContent = "-";
      ui.bigReduct.textContent = "-";
      ui.bigMs.textContent = "-";
      ui.bigE.textContent = "-";

      const url = URL.createObjectURL(f);
      loadImage(url, (img) => {
        URL.revokeObjectURL(url);
        srcImg = img;

        ui.download.disabled = false;
        ui.bigBefore.textContent = `${img.width}x${img.height} ${fmtBytes(srcBytes)}`;

        cacheKey = "";
        paletteKey = "";
        lastExportBlob = null;

        requestRender(true);
      }, () => {
        ui.bigBefore.textContent = "load failed";
      });
    });

    // ========================
    // Presets (delegated)
    // ========================

    const PRESETS = {
      tiny:   { quality:22, bw:false, mode:"bits",    bits:5, paletteN:32, ditherType:"fs",       ditherStrength:70, blockSize:8,  blockStrength:35 },
      web:    { quality:35, bw:false, mode:"palette", bits:5, paletteN:48, ditherType:"ordered8", ditherStrength:60, blockSize:12, blockStrength:20 },
      fax:    { quality:55, bw:true,  mode:"bits",    bits:2, paletteN:2,  ditherType:"ordered8", ditherStrength:90, blockSize:10, blockStrength:10 },
      poster: { quality:45, bw:false, mode:"palette", bits:5, paletteN:16, ditherType:"fs",       ditherStrength:85, blockSize:8,  blockStrength:25 },
      pixel:  { quality:70, bw:false, mode:"palette", bits:5, paletteN:32, ditherType:"none",     ditherStrength:0,  blockSize:10, blockStrength:100 },
      news:   { quality:38, bw:true,  mode:"palette", bits:4, paletteN:8,  ditherType:"ordered8", ditherStrength:85, blockSize:6,  blockStrength:15 },
      glitch: { quality:42, bw:false, mode:"palette", bits:5, paletteN:12, ditherType:"random",   ditherStrength:55, blockSize:16, blockStrength:70 },
    };

    function applyPreset(p) {
      const presetScale = 15;

      ui.quality.value = String(p.quality);
      ui.scale.value = String(presetScale);

      ui.bw.checked = !!p.bw;
      ui.mode.value = p.mode;
      syncModeBlocks();

      ui.bits.value = ui.bitsNum.value = String(p.bits);
      ui.palette.value = ui.paletteNum.value = String(p.paletteN);

      ui.ditherType.value = p.ditherType;
      ui.ditherStrength.value = String(p.ditherStrength);

      ui.blockSize.value = String(p.blockSize);
      ui.blockStrength.value = String(p.blockStrength);

      syncUI();
      requestRender(true);
      setActivePreset(
  Object.keys(PRESETS).find(k => PRESETS[k] === p) );
    }

    document.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-preset]");
      if (!btn) return;
      const key = btn.getAttribute("data-preset");
      const p = PRESETS[key];
      if (p) applyPreset(p);
    });

    // ========================
    // Download (picker once)
    // ========================

    async function downloadWithPickerOnce(filename, blob) {
      const key = "sic_used_save_picker_v1";
      const used = localStorage.getItem(key) === "1";
      const canPicker = typeof window.showSaveFilePicker === "function";

      if (!used && canPicker) {
        localStorage.setItem(key, "1");
        try {
          const handle = await window.showSaveFilePicker({
            suggestedName: filename,
            types: [{ description: "JPEG Image", accept: { "image/jpeg": [".jpg", ".jpeg"] } }],
          });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          return;
        } catch {
          // fallback
        }
      }

      const a = document.createElement("a");
      const url = URL.createObjectURL(blob);
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 500);
    }

    ui.download.addEventListener("click", async () => {
      if (!srcImg) return;

      requestRender(false);

      const s = getSettings();
      let blob = lastExportBlob;

      if (!blob || lastExportW !== stage2.width || lastExportH !== stage2.height) {
        const tmp = makeCanvas(stage2.width, stage2.height);
        putImageData(stage2, tmp);
        blob = await canvasToBlob(tmp, s.mime, s.quality);
        lastExportBlob = blob;
        ui.bigE.textContent = blob ? fmtBytes(blob.size) : "-";
      }
      if (!blob) return;

      const suffix = [
        `q${Math.round(s.quality * 100)}`,
        `s${Math.round(s.scale * 100)}`,
        s.bw ? "bw" : "rgb",
        s.mode === "palette" ? `pal${s.paletteN}` : `b${s.bits}`,
        `d${s.ditherType}${Math.round(s.ditherStrength * 100)}`,
        `blk${s.blockSize}-${Math.round(s.blockStrength * 100)}`,
      ].join("_");

      await downloadWithPickerOnce(`${srcName}_${suffix}.jpg`, blob);
    });

    // init
    syncUI();
    setTab("basic");
    applyPreset(PRESETS.fax);