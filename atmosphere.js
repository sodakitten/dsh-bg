//hello,starstreaming
(() => {
  "use strict";

  const STYLE_ID = "beauticode-atmosphere-style";
  const ROOT_ID = "beauticode-gallery-bg";
  const CANVAS_URL =
    (typeof globalThis !== "undefined" && globalThis.__BEAUTICODE_CANVAS_URL) ||
    "/__beauticode/themes/bg-canvas.png?v=uhd";

  function createWaterSim(simWidth, simHeight) {
    const width = Math.max(24, simWidth | 0);
    const height = Math.max(16, simHeight | 0);
    let current = new Float32Array(width * height);
    let next = new Float32Array(width * height);
    let clock = 0;

    function poke(cx, cy, strength, radius) {
      const x0 = cx | 0;
      const y0 = cy | 0;
      const rad = Math.max(1, radius);
      const r2 = rad * rad;
      const reach = Math.ceil(rad);
      for (let y = -reach; y <= reach; y += 1) {
        for (let x = -reach; x <= reach; x += 1) {
          const px = x0 + x;
          const py = y0 + y;
          if (px < 1 || py < 1 || px >= width - 1 || py >= height - 1) continue;
          const falloff = (x * x + y * y) / r2;
          if (falloff > 1) continue;
          current[py * width + px] += strength * (0.5 + 0.5 * Math.cos(Math.PI * Math.sqrt(falloff)));
        }
      }
    }

    function step(dt) {
      clock += dt;
      for (let y = 1; y < height - 1; y += 1) {
        let i = y * width + 1;
        for (let x = 1; x < width - 1; x += 1, i += 1) {
          next[i] =
            ((current[i - 1] + current[i + 1] + current[i - width] + current[i + width]) * 0.5 -
              next[i]) *
              0.9855 +
            0.0024 * Math.sin(clock * 0.7 + x * 0.05 + y * 0.021) +
            0.0019 * Math.sin(clock * 0.43 - x * 0.023 + y * 0.041);
        }
      }
      const swap = current;
      current = next;
      next = swap;
    }

    return {
      width,
      height,
      poke,
      step,
      heights() {
        return current;
      },
    };
  }

  function ensureStyle() {
    if (typeof document === "undefined") return null;
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      document.head.append(style);
    }
    style.textContent = `
#beauticode-gallery-bg{position:fixed;inset:-1px;z-index:0;overflow:hidden;pointer-events:none;background:#0b1018}
#beauticode-gallery-bg[data-bc-stage="true"]{background:transparent}
#beauticode-gallery-bg img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center center;display:block;pointer-events:none;z-index:0;image-rendering:auto;-webkit-backface-visibility:hidden}
#beauticode-gallery-bg canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1;mix-blend-mode:soft-light;opacity:.32}
html[data-bc-gallery="true"]:not([data-bc-gallery-stage]) #beauticode-bg-stage{background:transparent!important}
html[data-bc-gallery="true"]:not([data-bc-gallery-stage]) #beauticode-bg-stage::after{display:none!important;background:transparent!important}
html[data-bc-gallery="true"],html[data-bc-gallery="true"] body{background:transparent!important}
html[data-bc-gallery="true"] body{
  --dsw-alias-bg-base:rgba(17,20,27,.10);
  --dsw-alias-bg-layer-1:rgba(26,30,39,.28);
  --dsw-alias-bg-layer-2:rgba(35,40,51,.32);
  --dsw-alias-bg-overlay:rgba(17,20,27,.12);
  --dsw-specific-sidebar-fill:rgba(23,27,35,.36);
}
html[data-bc-resolved-tone="light"][data-bc-gallery="true"] body{
  --dsw-alias-bg-base:rgba(248,250,252,.12);
  --dsw-alias-bg-layer-1:rgba(255,255,255,.28);
  --dsw-alias-bg-layer-2:rgba(248,250,252,.32);
  --dsw-alias-bg-overlay:rgba(255,255,255,.14);
  --dsw-specific-sidebar-fill:rgba(255,255,255,.36);
}
html[data-bc-gallery="true"] #root{position:relative;z-index:1;background:transparent!important}
html[data-bc-gallery="true"] [class*="_sidebarCol"] [class*="_fade"]:empty{display:none!important}
html[data-bc-gallery="true"]:not([data-bc-gallery-stage]) #beauticode-bg-stage img,
html[data-bc-gallery="true"]:not([data-bc-gallery-stage]) #beauticode-bg-stage video{opacity:0!important}
html[data-bc-fish="true"] #root{opacity:0!important;visibility:hidden!important;pointer-events:none!important}
`;
    return style;
  }

  const runtime = {
    windowMode: "closed",
    layer: null,
    token: 0,
    loop: 0,
    lastTick: 0,
    pending: null,
    cancelPending: null,
  };

  function stopLoop() {
    if (runtime.loop) {
      cancelAnimationFrame(runtime.loop);
      runtime.loop = 0;
    }
  }

  function attachWater(canvas) {
    const dpr = () => Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    let sim = null;
    let output = null;
    let work = null;
    let last = null;

    function sizeSim() {
      const width = Math.max(32, canvas.clientWidth || window.innerWidth || 1);
      const height = Math.max(32, canvas.clientHeight || window.innerHeight || 1);
      const pixel = dpr();
      canvas.width = Math.round(width * pixel);
      canvas.height = Math.round(height * pixel);
      const simWidth = Math.max(80, Math.min(420, Math.round(width / 4)));
      const simHeight = Math.max(45, Math.round(simWidth * (height / width)));
      sim = createWaterSim(simWidth, simHeight);
      output = null;
      work = null;
    }

    function localPoint(event) {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height || !sim) return null;
      return {
        x: ((event.clientX - rect.left) / rect.width) * sim.width,
        y: ((event.clientY - rect.top) / rect.height) * sim.height,
      };
    }

    function follow(event) {
      if (!sim) return;
      const point = localPoint(event);
      if (!point) return;
      if (last) {
        const dx = point.x - last.x;
        const dy = point.y - last.y;
        const dist = Math.hypot(dx, dy);
        const steps = Math.max(1, Math.min(8, Math.ceil(dist / 6)));
        const strength = 0.55 + Math.min(1.8, dist / 18);
        for (let i = 1; i <= steps; i += 1) {
          const t = i / steps;
          sim.poke(last.x + dx * t, last.y + dy * t, strength / steps, 2.4);
        }
      } else {
        sim.poke(point.x, point.y, 0.7, 2.2);
      }
      last = point;
    }

    function render() {
      if (!sim) return;
      sim.step(0.033);
      const ctx = canvas.getContext("2d");
      if (!output) output = ctx.createImageData(sim.width, sim.height);
      const dest = output.data;
      const heights = sim.heights();
      for (let y = 0; y < sim.height; y += 1) {
        const up = y > 0 ? y - 1 : y;
        const down = y < sim.height - 1 ? y + 1 : y;
        for (let x = 0; x < sim.width; x += 1) {
          const i = y * sim.width + x;
          const gx = heights[x > 0 ? i - 1 : i] - heights[x < sim.width - 1 ? i + 1 : i];
          const gy = heights[up * sim.width + x] - heights[down * sim.width + x];
          const di = i * 4;
          let alpha = gy * 160;
          if (alpha >= 0) {
            dest[di] = 224;
            dest[di + 1] = 238;
            dest[di + 2] = 255;
            dest[di + 3] = alpha > 110 ? 110 : alpha;
          } else {
            alpha = -alpha;
            dest[di] = 8;
            dest[di + 1] = 16;
            dest[di + 2] = 32;
            dest[di + 3] = alpha > 90 ? 90 : alpha;
          }
        }
      }
      if (!work) {
        work = document.createElement("canvas");
        work.width = sim.width;
        work.height = sim.height;
      }
      work.getContext("2d").putImageData(output, 0, 0);
      const pixel = dpr();
      ctx.setTransform(pixel, 0, 0, pixel, 0, 0);
      ctx.imageSmoothingEnabled = true;
      if (ctx.imageSmoothingQuality) ctx.imageSmoothingQuality = "high";
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      ctx.drawImage(work, 0, 0, canvas.clientWidth, canvas.clientHeight);
    }

    sizeSim();
    window.addEventListener("pointermove", follow, { passive: true });
    window.addEventListener("resize", sizeSim);

    return {
      render,
      destroy() {
        window.removeEventListener("pointermove", follow);
        window.removeEventListener("resize", sizeSim);
      },
    };
  }

  function markPage(on) {
    const root = document.documentElement;
    if (on) {
      root.dataset.bcGallery = "true";
      root.dataset.bcActive = "true";
    } else {
      delete root.dataset.bcGallery;
      if (!document.querySelector("#beauticode-bg-stage img, #beauticode-bg-stage video")) {
        root.removeAttribute("data-bc-active");
      }
    }
  }

  function closeLayer() {
    runtime.token += 1;
    runtime.cancelPending?.();
    runtime.cancelPending = null;
    runtime.pending = null;
    stopLoop();
    runtime.layer?.water?.destroy();
    runtime.layer?.node.remove();
    runtime.layer = null;
    delete document.documentElement.dataset.bcGalleryStage;
    markPage(false);
  }

  async function openLayer(sourceImage) {
    const token = (runtime.token += 1);
    ensureStyle();
    const node = document.createElement("div");
    node.id = ROOT_ID;
    node.setAttribute("aria-hidden", "true");
    const image = document.createElement("img");
    image.alt = "";
    image.decoding = "async";
    image.fetchPriority = "high";
    image.draggable = false;
    const canvas = document.createElement("canvas");
    const reuseStage = sourceImage?.isConnected && sourceImage.naturalWidth > 0 &&
      Boolean(sourceImage.closest('#beauticode-bg-stage'));
    if (reuseStage) {
      node.dataset.bcStage = 'true';
      node.append(canvas);
    } else node.append(image, canvas);
    // Prepare off screen. Never hide the committed background before decode.
    const ready = reuseStage || await new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        image.onload = image.onerror = null;
        if (runtime.cancelPending === cancel) runtime.cancelPending = null;
        if (!ok) image.removeAttribute('src');
        resolve(ok);
      };
      const cancel = () => finish(false);
      const timer = setTimeout(() => finish(false), 8000);
      runtime.cancelPending = cancel;
      image.onload = () => {
        Promise.resolve(image.decode?.()).then(() => finish(image.naturalWidth > 0), () => finish(false));
      };
      image.onerror = () => finish(false);
      // Standalone fallback only. Normal bridge applies keep the already
      // decoded image in its stage and add just the water canvas above it.
      image.src = sourceImage?.currentSrc || sourceImage?.src || CANVAS_URL;
    });
    if (!ready || token !== runtime.token || runtime.windowMode === "closed") {
      node.remove();
      if (token === runtime.token) runtime.windowMode = 'closed';
      return;
    }
    document.body.prepend(node);
    const water = attachWater(canvas);
    runtime.layer = { node, water };
    if (reuseStage) document.documentElement.dataset.bcGalleryStage = 'true';
    markPage(true);
    const tick = (ts) => {
      if (!runtime.layer) return;
      if (document.visibilityState !== 'hidden' && ts - runtime.lastTick > 32) {
        runtime.lastTick = ts;
        water.render();
      }
      runtime.loop = requestAnimationFrame(tick);
    };
    runtime.loop = requestAnimationFrame(tick);
  }

  function setWindowMode(mode, sourceImage) {
    const next = mode === "on" || mode === "window" || mode === "full" ? "on" : "closed";
    runtime.windowMode = next;
    if (next === "closed") {
      closeLayer();
      return Promise.resolve(next);
    }
    if (runtime.layer) return Promise.resolve(next);
    if (runtime.pending) return runtime.pending;
    const pending = openLayer(sourceImage).then(() => runtime.windowMode).catch(() => {
      if (runtime.pending === pending) {
        runtime.windowMode = 'closed';
        closeLayer();
      }
      return runtime.windowMode;
    }).finally(() => {
      if (runtime.pending === pending) runtime.pending = null;
    });
    runtime.pending = pending;
    return pending;
  }

  function getState() {
    return { windowMode: runtime.windowMode };
  }

  const api = {
    createWaterSim,
    setWindowMode,
    getState,
  };

  globalThis.BeauticodeAtmosphere = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();
