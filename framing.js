/**
 * dsh-bg-crop — framing and interface transparency for beautiCode backgrounds.
 *
 * PART 1 — VISUAL FRAMING (pan + zoom)
 * beautiCode renders the background media as
 *   position:absolute; inset:0; width:100%; height:100%; object-fit:cover
 * (client.js:189). `cover` keeps the aspect ratio and fills the viewport, so a
 * source whose aspect differs from the viewport is cropped — always about the
 * centre, with no way to choose which part survives.
 *
 * Instead of letting `cover` clip inside a viewport-sized box, the media element
 * is resized to the size it *would* have under `cover` (a × boxW, b × boxH, where
 * a,b >= 1) and then transformed:
 *
 *     transform-origin: center center
 *     transform: translate(-50%,-50%) translate(tx%,ty%) scale(z)
 *
 * The element is now free to be larger than the viewport, so panning reaches the
 * whole picture — including the regions plain `cover` would have discarded. The
 * parent `.beauticode-media-slot` already has `overflow:hidden`, which does the
 * actual clipping.
 *
 * Because `width`/`height` are percentages of the box and `translate` uses
 * percentages of the element, every value is resolution independent: the same
 * numbers frame the full-size background and the small preview identically.
 *
 * Coverage stays complete while |tx| <= 50·(z − 1/a) and |ty| <= 50·(z − 1/b) —
 * at z = 1 that is exactly the slack `cover` used to consume.
 *
 * PART 2 — INTERFACE TRANSPARENCY
 * DSH paints the two columns from different tokens (dsh-client-ui-layout):
 *
 *     .sidebarCol { background: var(--dsw-specific-sidebar-fill) }
 *     .centerCol  { background: var(--dsw-alias-bg-base) }
 *
 * beautiCode overrides both, but derives the sidebar from --bc-surface-mix while
 * hard-coding the centre column, and it raises both sharply once a conversation
 * is live (`:has(#root [data-phase="active"])`: surface mix 36% -> 86%, centre
 * column 12% -> 48% light). The sidebar therefore reads as a solid slab over the
 * wallpaper.
 *
 * The fix aliases the sidebar fill to the centre column's token, so both columns
 * are always the same material, and re-derives the live-conversation tier from a
 * single user-set multiplier (--bgc-ui) instead of a hard-coded constant.
 *
 * beautiCode has one escape hatch of its own: once 背景阴影 has a value it sets
 * `data-bc-dim-user="true"` and switches the live phase back to the translucent
 * palette, darkening the wallpaper instead. The baseline constants below mirror
 * that state too, so this plugin's multiplier composes with it rather than
 * fighting it.
 *
 * This file never touches beautiCode's own files or state: it writes only to its
 * own localStorage keys and reads /__beauticode/ui/status to learn which
 * background is current.
 */
(() => {
  "use strict";

  const FLAG = "__dshBgCropInstalled";
  if (window[FLAG]) return;
  window[FLAG] = true;

  const STORE_KEY = "dsh-bg-crop/v1";
  const SETTINGS_KEY = "dsh-bg-crop/settings/v1";
  const MIN_ZOOM = 1;
  const MAX_ZOOM = 4;
  const DENSITY_MIN = 0.15;
  const DENSITY_MAX = 1.5;
  const DENSITY_DEFAULT = 1.5;
  const STAGE_ID = "beauticode-bg-stage";
  /** The atmosphere layer. 画窗 paints its background here, not in the stage. */
  const GALLERY_ID = "beauticode-gallery-bg";
  const PAGE_ID = "beauticode-console-page";
  const BLOCK_ID = "bgc-block";
  const UI_BLOCK_ID = "bgc-ui-block";
  const STATUS_URL = "/__beauticode/ui/status";

  const STAGE_SELECTOR = `#${STAGE_ID} .beauticode-media-slot img, #${STAGE_ID} .beauticode-media-slot video, #${GALLERY_ID} img`;

  /** Inline properties we own; clearing them restores beautiCode's defaults. */
  const OWNED = ["inset", "left", "top", "width", "height", "object-fit", "transform-origin", "transform"];

  const IDENTITY = { zoom: 1, tx: 0, ty: 0 };

  let store = readStore();
  let settings = readSettings();
  let key = null;                       // identity of the background currently framed
  let frame = { ...IDENTITY };
  let saveTimer = null;
  let identityInFlight = false;
  // A background change that arrives while a refresh is already running.
  let identityReplay = false;

  /* ------------------------------------------------------------------ store */

  function readJson(storageKey, fallback) {
    try {
      const raw = localStorage.getItem(storageKey);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === "object" ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  function readStore() {
    return readJson(STORE_KEY, {});
  }

  function readSettings() {
    const raw = readJson(SETTINGS_KEY, {});
    const density = Number(raw.density);

    return {
      // Default on: matching the two columns is the sane look, and the writer
      // only ever built the mismatched one because nothing could change it.
      sidebarFollow: raw.sidebarFollow !== false,
      // Default on: the edge fill is what stops the page background showing through
      // as a rim around the wallpaper. Same shape as sidebarFollow — only an explicit
      // false turns it off.
      edgeFill: raw.edgeFill !== false,
      density: Number.isFinite(density)
        ? Math.min(DENSITY_MAX, Math.max(DENSITY_MIN, density))
        : DENSITY_DEFAULT,
      // The Windows title strip follows the content unless asked otherwise.
    };
  }

  function writeSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* storage unavailable — the controls still work for this session */
    }
  }

  function scheduleSave() {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (!key) return;
      if (isIdentity(frame)) delete store[key];
      else store[key] = { ...frame };
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(store));
      } catch {
        /* storage unavailable — framing still works for this session */
      }
    }, 250);
  }

  function isIdentity(f) {
    return f.zoom <= 1.0001 && Math.abs(f.tx) < 0.01 && Math.abs(f.ty) < 0.01;
  }

  function normaliseFrame(value) {
    const zoom = Number(value?.zoom);
    const tx = Number(value?.tx);
    const ty = Number(value?.ty);
    return {
      zoom: Number.isFinite(zoom) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) : 1,
      tx: Number.isFinite(tx) ? tx : 0,
      ty: Number.isFinite(ty) ? ty : 0,
    };
  }

  /** Push the transparency settings onto the document root. */
  function applySettings() {
    const root = document.documentElement;
    if (settings.sidebarFollow) root.dataset.bgcSidebar = "follow";
    else delete root.dataset.bgcSidebar;
    root.style.setProperty("--bgc-ui", settings.density.toFixed(3));
    if (settings.edgeFill) root.dataset.bgcEdge = "fill";
    else delete root.dataset.bgcEdge;

  }

  /* --------------------------------------------------------------- geometry */

  function stageElement() {
    return document.getElementById(STAGE_ID);
  }

  function stageBox() {
    return { w: window.innerWidth, h: window.innerHeight };
  }

  function naturalSize(el) {
    if (!el) return null;
    const w = el.tagName === "VIDEO" ? el.videoWidth : el.naturalWidth;
    const h = el.tagName === "VIDEO" ? el.videoHeight : el.naturalHeight;
    return w > 0 && h > 0 ? { w, h } : null;
  }

  /**
   * Element size under `cover`, expressed as a percentage of the box, plus the
   * coverage ratios a (width) and b (height) that bound panning.
   *
   * Percentages depend only on the *ratio* of image to box, so the preview box
   * (which is given the viewport's aspect ratio) gets identical numbers.
   */
  function metrics(el) {
    const natural = naturalSize(el);
    if (!natural) return null;
    const { w: boxW, h: boxH } = stageBox();
    if (!boxW || !boxH) return null;
    const rImg = natural.w / natural.h;
    const rBox = boxW / boxH;
    if (rImg >= rBox) {
      // Image is relatively wider: cover matches the height, overflowing sideways.
      const a = rImg / rBox;
      return { wPct: a * 100, hPct: 100, a, b: 1 };
    }
    // Image is relatively taller: cover matches the width, overflowing vertically.
    const b = rBox / rImg;
    return { wPct: 100, hPct: b * 100, a: 1, b };
  }

  function clampFrame(m) {
    const limitX = Math.max(0, 50 * (frame.zoom - 1 / m.a));
    const limitY = Math.max(0, 50 * (frame.zoom - 1 / m.b));
    frame.tx = Math.min(limitX, Math.max(-limitX, frame.tx));
    frame.ty = Math.min(limitY, Math.max(-limitY, frame.ty));
  }

  /* ------------------------------------------------------------- apply pass */

  function clearElement(el) {
    for (const prop of OWNED) el.style.removeProperty(prop);
  }

  function styleElement(el, m) {
    el.style.setProperty("inset", "auto");
    el.style.setProperty("left", "50%");
    el.style.setProperty("top", "50%");
    el.style.setProperty("width", `${m.wPct.toFixed(4)}%`);
    el.style.setProperty("height", `${m.hPct.toFixed(4)}%`);
    // The box aspect now equals the image aspect, so `cover` fills it exactly and
    // can never distort; it only guards against percentage rounding.
    el.style.setProperty("object-fit", "cover");
    el.style.setProperty("transform-origin", "center center");
    el.style.setProperty(
      "transform",
      isIdentity(frame)
        ? "translate(-50%, -50%)"
        : `translate(-50%, -50%) translate(${frame.tx.toFixed(4)}%, ${frame.ty.toFixed(4)}%) scale(${frame.zoom.toFixed(5)})`,
    );
  }

  function mediaElements() {
    return Array.from(document.querySelectorAll(STAGE_SELECTOR));
  }

  /**
   * The slot beautiCode is showing: an incoming candidate wins while it exists,
   * otherwise the current one, otherwise whatever carries a source.
   */
  function primaryMedia() {
    const elements = mediaElements();
    if (!elements.length) return null;
    // Under the gallery preset the stage media are hidden; the atmosphere
    // layer is what the user is looking at, so it is the one to frame.
    if (document.documentElement.hasAttribute("data-bc-gallery")) {
      const gallery = elements.find((el) => el.closest(`#${GALLERY_ID}`));
      if (gallery) return gallery;
    }
    const candidate = elements.find((el) => el.closest('[data-bc-role="candidate"]'));
    if (candidate) return candidate;
    const current = elements.find((el) => el.closest('[data-bc-role="current"]'));
    if (current) return current;
    return elements.find((el) => el.currentSrc || el.src) ?? elements[0];
  }

  /** Re-frame every background media element. Safe to call at any time. */
  function apply() {
    const elements = mediaElements();
    if (!elements.length) {
      applyToPreview(null);
      return;
    }

    for (const el of elements) {
      const m = metrics(el);
      if (!m) {
        // Dimensions are unknown until the media decodes; keep beautiCode's
        // default until then and re-run once it becomes measurable.
        clearElement(el);
        watchDecode(el);
        continue;
      }
      clampFrame(m);
      styleElement(el, m);
    }

    applyToPreview(primaryMedia());
    syncControls();
  }

  /** Re-apply once an element reports its intrinsic size. */
  function watchDecode(el) {
    if (el.dataset.bgcDecodeWatch === "1") return;
    el.dataset.bgcDecodeWatch = "1";
    const done = () => {
      delete el.dataset.bgcDecodeWatch;
      queueApply();
    };
    el.addEventListener(el.tagName === "VIDEO" ? "loadedmetadata" : "load", done, { once: true });
    el.addEventListener("error", () => delete el.dataset.bgcDecodeWatch, { once: true });
  }

  /* -------------------------------------------------------------- identity  */

  function mediaPathKey() {
    const el = primaryMedia();
    const raw = el?.currentSrc || el?.src || "";
    if (!raw) return null;
    try {
      return `src:${new URL(raw, location.href).pathname}`;
    } catch {
      return `src:${raw}`;
    }
  }

  /**
   * beautiCode saves every import as a theme, so `themeId` is the stable name of
   * the current background across reloads. Fall back to the media path when a
   * background exists without a saved theme.
   */
  async function refreshIdentity(options) {
    const applyAfter = Boolean(options && options.applyAfter);
    if (identityInFlight) {
      // The newest background must win, not whichever one the in-flight call
      // started with, so replay once it finishes.
      if (applyAfter) identityReplay = true;
      return;
    }
    identityInFlight = true;
    try {
      let next = null;
      try {
        // The route rejects dsh-app://app on origin alone, so the desktop key
        // the injector publishes is what actually authorises this call.
        const desktopKey = globalThis.__BEAUTICODE_DESKTOP_KEY__;
        const response = await fetch(STATUS_URL, {
          credentials: "same-origin",
          headers:
            typeof desktopKey === "string" ? { "x-beauticode-desktop-key": desktopKey } : {},
        });
        if (response.ok) {
          const payload = await response.json();
          if (payload && payload.ok) {
            // The carousel's add-picker needs the same list the console shows,
            // and this fetch already happens whenever the background changes.
            if (Array.isArray(payload.themes)) {
              carouselThemes = payload.themes;
              renderCarousel();
            }
            // Prefer the plugin's own record: it is generation-checked and
            // survives a host restart, where themeId cannot because the
            // session's field lives in memory and clears on startup.
            if (typeof payload.identity === 'string' && payload.identity) {
              next = payload.identity;
            } else if (payload.themeId) next = `theme:${payload.themeId}`;
            // A preset is applied with persistTheme:false, so it leaves
            // themeId null and would otherwise fall through to the media
            // path — which is a random token regenerated on every apply.
            // That made all presets share one crop, and lose it on every
            // carousel tick. The status route reports the live preset, and a
            // preset id is stable, so it makes a usable identity.
            else if (payload.atmosphere) next = `atmo:${payload.atmosphere}`;
          }
        }
      } catch {
        /* status is a nicety; the media path is always available */
      }
      if (!next) next = mediaPathKey();
      if (next !== key) {
        key = next;
        frame = normaliseFrame(key ? store[key] : null);
        // The settings page marks the background in use with a green dot, and it
        // only re-reads that when the page opens — so during rotation it lagged
        // until settings was closed and reopened. Announce the move instead; the
        // console listens. Only on an actual change, not on every re-render.
        try {
          document.dispatchEvent(new CustomEvent("bgc:background-changed"));
        } catch {
          /* the dot simply stays stale */
        }
      }
    } finally {
      identityInFlight = false;
    }
    // Applying only on a key CHANGE would leave a re-rendered slot unstyled.
    if (!applyAfter) return;
    apply();
    if (identityReplay) {
      identityReplay = false;
      void refreshIdentity({ applyAfter: true });
    }
  }


  /* ------------------------------------------------------------ live wiring */

  let applyQueued = false;
  function queueApply() {
    if (applyQueued) return;
    applyQueued = true;
    requestAnimationFrame(() => {
      applyQueued = false;
      apply();
    });
  }

  /**
   * Watch the whole document (beautiCode builds its stage lazily) but react only
   * to records that actually concern the stage — the app mutates its own DOM
   * constantly while streaming, and those records must not cost a fetch.
   */
  function recordTouchesStage(record) {
    const stage = stageElement();
    const gallery = document.getElementById(GALLERY_ID);
    const isStageNode = (node) => {
      if (!node || node.nodeType !== 1) return false;
      if (node.id === STAGE_ID || node.id === GALLERY_ID) return true;
      return Boolean(stage) && stage.contains(node);
    };
    if (stage && (record.target === stage || stage.contains(record.target))) return true;
    if (gallery && (record.target === gallery || gallery.contains(record.target))) return true;
    for (const node of record.addedNodes) if (isStageNode(node)) return true;
    for (const node of record.removedNodes) if (isStageNode(node)) return true;
    return false;
  }

  function startStageObserver() {
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (!recordTouchesStage(record)) continue;
        // Refresh FIRST, apply second. beautiCode swaps whole slots when the
        // background changes, and a cached image measures immediately — so
        // applying first painted the PREVIOUS background's frame onto the new
        // one until the identity came back. With the debounce in front of that
        // fetch the wrong frame stayed up for roughly a third of a second, which
        // is the jump visible on every carousel switch.
        //
        // A background change is the one moment the identity must be re-read, so
        // the debounce is skipped here and the apply happens inside the refresh.
        void refreshIdentity({ applyAfter: true });
        return;
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "data-bc-role", "data-bc-video-ready"],
    });
  }

  window.addEventListener("resize", () => {
    updatePreviewAspect();
    queueApply();
  });

  /* ----------------------------------------------------------------- styles */

  const CROP_STYLE = `
#${BLOCK_ID} .bgc-frame{position:relative;width:100%;aspect-ratio:16 / 9;margin:2px 0 10px;overflow:hidden;border-radius:12px;
  border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));background:rgba(127,127,127,.12);
  cursor:grab;touch-action:none;user-select:none}
#${BLOCK_ID} .bgc-frame[data-dragging="true"]{cursor:grabbing}
#${BLOCK_ID} .bgc-frame img,#${BLOCK_ID} .bgc-frame video{position:absolute;z-index:1;display:block;pointer-events:none;
  transition:none !important}
#${BLOCK_ID} .bgc-grid{position:absolute;inset:0;z-index:2;pointer-events:none;opacity:.45;
  background:
    linear-gradient(to right,transparent calc(33.333% - .5px),var(--dsw-alias-border-l3,rgba(127,127,127,.5)) calc(33.333% - .5px),
      var(--dsw-alias-border-l3,rgba(127,127,127,.5)) calc(33.333% + .5px),transparent calc(33.333% + .5px),
      transparent calc(66.666% - .5px),var(--dsw-alias-border-l3,rgba(127,127,127,.5)) calc(66.666% - .5px),
      var(--dsw-alias-border-l3,rgba(127,127,127,.5)) calc(66.666% + .5px),transparent calc(66.666% + .5px)),
    linear-gradient(to bottom,transparent calc(33.333% - .5px),var(--dsw-alias-border-l3,rgba(127,127,127,.5)) calc(33.333% - .5px),
      var(--dsw-alias-border-l3,rgba(127,127,127,.5)) calc(33.333% + .5px),transparent calc(33.333% + .5px),
      transparent calc(66.666% - .5px),var(--dsw-alias-border-l3,rgba(127,127,127,.5)) calc(66.666% - .5px),
      var(--dsw-alias-border-l3,rgba(127,127,127,.5)) calc(66.666% + .5px),transparent calc(66.666% + .5px))}
#${BLOCK_ID} .bgc-zoomrow{display:flex;align-items:center;gap:10px;padding:0 0 4px}
#${BLOCK_ID} .bgc-zoomlabel{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;flex:none}
#${BLOCK_ID} .bgc-zoom{flex:1;min-width:0;accent-color:var(--dsw-alias-label-primary)}
#${BLOCK_ID} .bgc-zoomvalue{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;
  min-width:46px;text-align:right;flex:none;font-variant-numeric:tabular-nums}
#${BLOCK_ID} .bgc-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:0 0 8px}
#${BLOCK_ID} .bgc-body[hidden]{display:none}
#${BLOCK_ID} .bc-control{gap:6px}
#${BLOCK_ID} .bgc-reset{cursor:pointer;flex:none;display:inline-flex;align-items:center;justify-content:center;
  width:24px;height:24px;padding:0;border:0;border-radius:8px;background:0 0;color:var(--dsw-alias-label-tertiary)}
#${BLOCK_ID} .bgc-reset:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
#${BLOCK_ID}[data-bgc-empty="true"] .bgc-frame,#${BLOCK_ID}[data-bgc-empty="true"] .bgc-zoomrow,
#${BLOCK_ID}[data-bgc-empty="true"] [data-bgc-act="reset"]{display:none}
`;

  /**
   * Mirrors beautiCode's own control styling (console.js:40-50) so these rows sit
   * in its panel as if the author had written them. The class names are ours on
   * purpose: console.js resolves its dim controls with page.querySelector, and a
   * second .bc-dim-slider would risk capturing that lookup.
   */
  const UI_STYLE = `
#${UI_BLOCK_ID} .bgc-sliderwrap{display:inline-flex;align-items:center;gap:8px;height:36px;padding:0 14px;border-radius:18px;background:var(--dsw-alias-bg-module-platform)}
#${UI_BLOCK_ID} .bgc-range{-webkit-appearance:none;appearance:none;width:120px;height:4px;margin:0;padding:0;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer}
#${UI_BLOCK_ID} .bgc-range::-webkit-slider-runnable-track{height:4px;border-radius:999px;background:var(--dsw-alias-border-l3)}
#${UI_BLOCK_ID} .bgc-range::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;margin-top:-5px;border:.5px solid var(--dsw-alias-border-l4);border-radius:50%;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-shadow-lv1);cursor:pointer}
#${UI_BLOCK_ID} .bgc-value{min-width:2.6em;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;text-align:right}
/* Carousel section: reuses the panel's own controls so it reads as part of the
   same block rather than a bolt-on. */
#${UI_BLOCK_ID} .bgc-crow{display:flex;align-items:center;gap:8px;padding:0 0 8px}
#${UI_BLOCK_ID} .bgc-crow-top{align-items:flex-start}
#${UI_BLOCK_ID} .bgc-clabel{flex:none;width:2.6em;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:32px}
#${UI_BLOCK_ID} .bgc-cselect{flex:1;min-width:0;height:32px;padding:0 8px;border:0;border-radius:8px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font-size:13px}
#${UI_BLOCK_ID} .bgc-cinput{flex:1;min-width:0;height:32px;padding:0 10px;border:0;border-radius:8px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font-size:13px}
#${UI_BLOCK_ID} .bgc-cmini{flex:none}
#${UI_BLOCK_ID} .bgc-crange{flex:1;min-width:0}
#${UI_BLOCK_ID} .bgc-cstatus{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px}
#${UI_BLOCK_ID} .bgc-citems{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
#${UI_BLOCK_ID} .bgc-citem{display:flex;align-items:center;gap:6px;height:32px;padding:0 4px 0 10px;border-radius:8px;background:var(--dsw-alias-bg-module-platform)}
#${UI_BLOCK_ID} .bgc-citem-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:var(--dsw-alias-label-primary)}
#${UI_BLOCK_ID} .bgc-citem.is-missing .bgc-citem-name{text-decoration:line-through;color:var(--dsw-alias-label-tertiary)}
#${UI_BLOCK_ID} .bgc-cbtn{cursor:pointer;flex:none;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1}
#${UI_BLOCK_ID} .bgc-cbtn:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
#${UI_BLOCK_ID} .bgc-cbtn:disabled{opacity:.35;cursor:default}
#${UI_BLOCK_ID} .bgc-cempty{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:32px}
#${UI_BLOCK_ID} .bgc-reset{cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:8px;background:0 0;color:var(--dsw-alias-label-tertiary)}
#${UI_BLOCK_ID} .bgc-reset:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
`;

  /**
   * The transparency override itself. All beautiCode-owned tokens are written
   * with !important so the result does not depend on which <style> landed last,
   * and the baselines live in our own --bgc-* names so they never collide.
   */
  const TRANSPARENCY_STYLE = `
/* Both columns, one material: alias the sidebar fill to the centre column's
   token, so it follows every phase and every tone automatically. */
/* Both states alias on body, so the frame, its 40px strip, the sidebar column and
   the sidebar module root all take the content's material — the ON look is exactly
   what every release before v5.2 produced.

   No [class*="_frame"] selector here, deliberately: that substring is not unique.
   The build has eleven classes containing it across eight modules, several inside
   dsh-client-ui-chat, so painting a background through it veiled the chat history.
   A substring match on a build-stable half is only safe when the other half is
   unique, and "_frame" is not. */
html[data-bc-active="true"] body{
  --dsw-specific-sidebar-fill: var(--dsw-alias-bg-base) !important;
}

/* Switch off: only the sidebar subtree re-takes beautiCode's own value. Because the
   declaration sits on the column, the frame above it keeps the alias — which is what
   stops the whole window from going dense when the switch is turned off.

   The value is beautiCode's own formula, copied from its stylesheet rather than
   approximated, so "off" means exactly what it always meant. */
html[data-bc-active="true"]:not([data-bgc-sidebar="follow"]) [class*="_sidebarCol"]{
  --dsw-specific-sidebar-fill: color-mix(in srgb, var(--dsw-static-neutral-bluish-900) var(--bc-surface-mix), transparent) !important;
}
html[data-bc-resolved-tone="light"][data-bc-active="true"]:not([data-bgc-sidebar="follow"]) [class*="_sidebarCol"]{
  --dsw-specific-sidebar-fill: color-mix(in srgb, var(--dsw-static-neutral-bluish-50) var(--bc-surface-mix), transparent) !important;
}

/* Baseline: live conversation, no 背景阴影. Mirrors beautiCode's dense palette. */
html[data-bc-active="true"]:has(#root [data-phase="active"]) body,
html[data-bc-active="true"]:has(#root [data-phase="settling"]) body{
  --bgc-mix-surface:86%; --bgc-mix-content:72%;
  --bgc-rgb-base:17,20,27; --bgc-rgb-l1:26,30,39; --bgc-rgb-l2:35,40,51;
  --bgc-a-base:.42; --bgc-a-l1:.72; --bgc-a-l2:.80; --bgc-a-overlay:.86;
}
html[data-bc-resolved-tone="light"][data-bc-active="true"]:has(#root [data-phase="active"]) body,
html[data-bc-resolved-tone="light"][data-bc-active="true"]:has(#root [data-phase="settling"]) body{
  --bgc-rgb-base:248,250,252; --bgc-rgb-l1:255,255,255; --bgc-rgb-l2:248,250,252;
  --bgc-a-base:.48; --bgc-a-l1:.74; --bgc-a-l2:.82; --bgc-a-overlay:.86;
}

/* 背景阴影 deliberately does NOT select a tier here. Its only visible job is
   darkening the wallpaper through --bc-dim; the surface palette stays on the
   dense baseline whether the flag is set or not. A stored value of 0 used to
   flip the whole chrome to the translucent tier with no sign on screen. */

/* One multiplier, applied once. --bgc-ui is set on <html> by applySettings(). */
html[data-bc-active="true"]:has(#root [data-phase="active"]) body,
html[data-bc-active="true"]:has(#root [data-phase="settling"]) body{
  --bc-surface-mix:calc(var(--bgc-mix-surface,86%) * var(--bgc-ui,1)) !important;
  --bc-content-mix:calc(var(--bgc-mix-content,72%) * var(--bgc-ui,1)) !important;
  --dsw-alias-bg-base:rgba(var(--bgc-rgb-base,17,20,27),calc(var(--bgc-a-base,.42) * var(--bgc-ui,1))) !important;
  --dsw-alias-bg-layer-1:rgba(var(--bgc-rgb-l1,26,30,39),calc(var(--bgc-a-l1,.72) * var(--bgc-ui,1))) !important;
  --dsw-alias-bg-layer-2:rgba(var(--bgc-rgb-l2,35,40,51),calc(var(--bgc-a-l2,.80) * var(--bgc-ui,1))) !important;
  --dsw-alias-bg-overlay:rgba(var(--bgc-rgb-base,17,20,27),calc(var(--bgc-a-overlay,.86) * var(--bgc-ui,1))) !important;
}

/* Modal surfaces keep a fixed density. --bgc-ui is about how much wallpaper
   shows through the application chrome; a dialog is a foreground surface, and
   scaling it too lets the transcript behind it bleed through its own rows —
   two texts printed on top of each other. Declared on the dialog element so
   every token it paints with, and every descendant reading one, is covered
   without naming a build-generated class; a declaration on the element always
   beats the inherited value. Deliberately not scaled by any slider. */
/* The preload's caption probe. Pinning it here sets what the native window
   controls are painted with; a stylesheet !important outranks the inline value
   the preload wrote. --bgc-caption carries the sampled strip composite. */
[data-bgc-probe]{
  background-color: rgba(255, 255, 255, 0.01) !important;
}

/* The 新会话 pill and the account row at the foot of the sidebar were both painted
   as solid light surfaces, so each read as a white sticker laid over the wallpaper
   showing through. The workspace rows below already behave the way they should —
   no surface until the pointer arrives — so both are brought in line with them.

   :not(:hover) is what preserves the affordance: the background is forced
   transparent only while the pointer is elsewhere, so the control's own hover
   shading still lands. A bare !important would have flattened that too.

   The blur is dropped outright rather than set to zero: backdrop-filter paints the
   filtered backdrop even when the surface is fully transparent, which is exactly
   what "no background" is meant to avoid. */
[data-bgc-sidebar-action="1"],
[data-bgc-sidebar-account="1"]{
  -webkit-backdrop-filter:none !important;
  backdrop-filter:none !important;
}
[data-bgc-sidebar-action="1"]:not(:hover),
[data-bgc-sidebar-account="1"]:not(:hover){
  background-color:transparent !important;
}
/* The pill's own hover paint is the theme's warm neutral, so hovering produced a
   beige block over a blue wallpaper. Deriving the hover surface from the tone
   instead keeps it a neutral lift that belongs to whatever is behind it, and it
   cannot land on a warm colour by construction.
   Only the 新会话 pill is touched: the account row's own hover already reads
   correctly, and overriding a working state is how the previous rounds went wrong. */
[data-bgc-sidebar-action="1"]:hover{
  background-color:color-mix(in srgb, rgb(var(--bgc-rgb-base,248,250,252)) 20%, transparent) !important;
}
/* beautiCode fades --dsw-alias-bg-base in behind the composer across the full
   width of the seat. It never lines up with the card, so it reads as a stray
   tinted band beside and below it; the frosted card covers its own area now. */
[class*="_composerSeat"]{
  background-image:none !important;
}

/* The composer card is found at runtime (see tagComposerSurface) because its
   class name is not reachable from here: the seat is a full-width wrapper and
   the stack's first child is a 0x0 unclassed node. Blurring the backdrop of the
   card alone hides the transcript scrolling behind it without touching the
   page's transparency, and without touching the strip around the card. */
[data-bgc-composer="1"]{
  -webkit-backdrop-filter:blur(28px);
  backdrop-filter:blur(28px);
  /* Frosted glass rather than a white plate: a strong blur is what makes a glyph
     72% visible and a blurred glyph still reads. Thickening the surface is what
     actually removes the second text; the blur only softens what is left. */
  background-color:color-mix(in srgb, rgb(var(--bgc-rgb-base,248,250,252)) 55%, transparent) !important;
}

/* Context-compaction notices. The trajectory module paints them with
   --dsw-alias-bg-module-platform, which is color-mix(tone, --bc-surface-mix,
   transparent) — beautiCode's stock 36% outside the active/settling phases, and
   86% x density inside them. Either way the transcript behind the row reads through
   its label. Same treatment as the composer: a strong blur plus a plate.

   Literal tones rather than var(--bgc-rgb-base,...): that variable is only declared
   inside the active/settling blocks, so outside them its light-tone fallback would
   paint a white plate over a dark theme.

   :not([class*="_compactedS"]) excludes the module's own _compactedSummary — two
   nested elements each carrying a backdrop-filter would blur the backdrop twice. */
html[data-bc-active="true"] [class*="_compacted"]:not([class*="_compactedS"]){
  -webkit-backdrop-filter:blur(28px);
  backdrop-filter:blur(28px);
  background-color:color-mix(in srgb, rgb(17,20,27) 55%, transparent) !important;
}
html[data-bc-resolved-tone="light"][data-bc-active="true"] [class*="_compacted"]:not([class*="_compactedS"]){
  background-color:color-mix(in srgb, rgb(248,250,252) 55%, transparent) !important;
}

/* The 背景阴影 reset button was never styled — console.js defines
   .bc-blur-reset but no .bc-dim-reset, so it renders as a default browser
   button next to a styled one. Same declaration, class swapped. */
#beauticode-console-page .bc-dim-reset{cursor:pointer;display:inline-flex;align-items:center;
  justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:8px;
  background:0 0;color:var(--dsw-alias-label-tertiary)}
#beauticode-console-page .bc-dim-reset:hover{color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-interactive-bg-hover)}

/* 画窗 paints its own layer and disables the stage, which is what 背景阴影 and
   背景磨砂 both target — so on that preset both sliders move nothing. Point
   them at the visible layer instead. Scoped to the gallery flag throughout. */
html[data-bc-gallery="true"] #beauticode-gallery-bg img{
  filter:blur(var(--bc-bg-blur,0px));
}

/* Opt-in: take the blur off the wallpaper itself and put it on a full-viewport
   backdrop layer above it.

   filter:blur() samples beyond the element, so a full-bleed image fades to
   transparent in its outer pixels and the page's own background shows through —
   a thin rim that reads white on a light theme and black on a dark one. A
   backdrop-filter layer has no image edge of its own: its backdrop is the
   composited content behind it.

   z-index:1 sits above the <img> and below the ::after that carries the dim
   overlay. Off by default, and a no-op while 背景磨砂 is 0. */
html[data-bc-gallery="true"][data-bgc-edge="fill"] #beauticode-gallery-bg img{
  filter:none;
}
html[data-bc-gallery="true"][data-bgc-edge="fill"] #beauticode-gallery-bg::before{
  content:"";
  position:absolute;
  inset:0;
  z-index:1;
  pointer-events:none;
  -webkit-backdrop-filter:blur(var(--bc-bg-blur,0px));
  backdrop-filter:blur(var(--bc-bg-blur,0px));
}
html[data-bc-gallery="true"] #beauticode-gallery-bg::after{
  content:"";
  position:absolute;
  inset:0;
  z-index:2;
  pointer-events:none;
  background:rgba(0,0,0,var(--bc-dim,0));
}
html[data-bc-resolved-tone="light"][data-bc-gallery="true"] #beauticode-gallery-bg::after{
  background:rgba(255,255,255,var(--bc-dim,0));
}

html[data-bc-active="true"] [role="dialog"][aria-modal="true"]{
  --bc-surface-mix:86% !important;
  --bc-content-mix:72% !important;
  --dsw-alias-bg-base:rgba(17,20,27,.90) !important;
  --dsw-alias-bg-layer-1:rgba(26,30,39,.96) !important;
  --dsw-alias-bg-layer-2:rgba(35,40,51,.97) !important;
  --dsw-alias-bg-overlay:rgba(17,20,27,.97) !important;
  --dsw-specific-sidebar-fill:rgba(26,30,39,.96) !important;
}
html[data-bc-resolved-tone="light"][data-bc-active="true"] [role="dialog"][aria-modal="true"]{
  --dsw-alias-bg-base:rgba(248,250,252,.90) !important;
  --dsw-alias-bg-layer-1:rgba(255,255,255,.96) !important;
  --dsw-alias-bg-layer-2:rgba(248,250,252,.97) !important;
  --dsw-alias-bg-overlay:rgba(255,255,255,.97) !important;
  --dsw-specific-sidebar-fill:rgba(255,255,255,.96) !important;
}

/* DSH rounds the content column's top-left corner on Windows and lets the
   frame show through the notch — one translucent layer there, two inside the
   column. With a wallpaper behind it that reads as a torn edge, so square it
   while a background is active. Scoped to the Windows title-bar layout, and
   [class*="_centerCol"] is the build-stable half of the hashed class name. */
html[data-bc-active="true"][data-windows-titlebar] [class*="_centerCol"]{
  border-radius:0 !important;
}
`;

  function ensureStyle(id, css) {
    if (document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = css;
    document.head.append(style);
  }

  /* ------------------------------------------------------------------ crop UI */

  let block = null;
  let frameEl = null;
  let previewEl = null;
  let zoomSlider = null;
  let zoomValue = null;
  let hintEl = null;
  let cropToggle = null;
  let cropBody = null;
  let dragging = null;

  function buildBlock() {
    const el = document.createElement("div");
    el.className = "bc-group";
    el.id = BLOCK_ID;
    el.dataset.bgcEmpty = "true";
    el.innerHTML =
      '<div class="bc-row"><div class="bc-row-text">' +
      '<span class="bc-row-title">画面裁切</span>' +
      '<span class="bc-row-desc">展开后拖动预览调整位置、用滑块缩放</span>' +
      "</div>" +
      '<div class="bc-control">' +
      '<button type="button" class="bgc-reset" data-bgc-act="reset" aria-label="重置裁切" title="重置裁切">' +
      RESET_ICON +
      '</button>' +
      '<button type="button" class="bc-btn bc-pill" data-bgc-act="crop-toggle"' +
      ' aria-expanded="false" aria-controls="bgc-crop-body">调整</button></div>' +
      "</div>" +
      '<div class="bgc-body" id="bgc-crop-body" hidden>' +
      '<p class="bgc-hint" data-bgc-hint hidden>先导入一张背景图或视频，再调整裁切。</p>' +
      '<div class="bgc-frame" data-bgc-frame role="application" aria-label="背景裁切预览">' +
      '<div class="bgc-grid"></div>' +
      "</div>" +
      '<div class="bgc-zoomrow">' +
      '<span class="bgc-zoomlabel">缩放</span>' +
      '<input type="range" class="bgc-zoom" min="100" max="400" step="1" value="100" aria-label="背景缩放"/>' +
      '<span class="bgc-zoomvalue">1.00×</span>' +
      "</div>" +
      "</div>";

    frameEl = el.querySelector("[data-bgc-frame]");
    zoomSlider = el.querySelector(".bgc-zoom");
    zoomValue = el.querySelector(".bgc-zoomvalue");
    hintEl = el.querySelector("[data-bgc-hint]");
    cropToggle = el.querySelector('[data-bgc-act="crop-toggle"]');
    cropBody = el.querySelector(".bgc-body");

    // Never remembered across loads: an open drawer is a drag surface sitting
    // in the panel's first level, which is what this control exists to avoid.
    cropToggle.addEventListener("click", () => {
      const open = cropBody.hidden;
      cropBody.hidden = !open;
      cropToggle.textContent = open ? "收起" : "调整";
      cropToggle.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) {
        updatePreviewAspect();
        apply();
      }
    });

    el.querySelector('[data-bgc-act="reset"]').addEventListener("click", () => {
      frame = { ...IDENTITY };
      apply();
      scheduleSave();
    });

    zoomSlider.addEventListener("input", () => {
      const next = Number(zoomSlider.value) / 100;
      if (!Number.isFinite(next)) return;
      frame.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
      apply();
      scheduleSave();
    });

    frameEl.addEventListener("pointerdown", onPointerDown);
    frameEl.addEventListener("pointermove", onPointerMove);
    frameEl.addEventListener("pointerup", onPointerUp);
    frameEl.addEventListener("pointercancel", onPointerUp);

    return el;
  }

  /** Give the preview the viewport's aspect ratio so framing matches exactly. */
  function updatePreviewAspect() {
    if (!frameEl) return;
    const { w, h } = stageBox();
    if (w && h) frameEl.style.aspectRatio = `${w} / ${h}`;
  }

  /** Mirror the live media into the preview, using the same transform model. */
  function applyToPreview(sourceEl) {
    if (!frameEl) return;
    const m = sourceEl ? metrics(sourceEl) : null;

    if (!sourceEl || !m) {
      previewEl?.remove();
      previewEl = null;
      if (block) block.dataset.bgcEmpty = "true";
      if (hintEl) hintEl.hidden = false;
      return;
    }

    if (block) block.dataset.bgcEmpty = "false";
    if (hintEl) hintEl.hidden = true;

    const wanted = sourceEl.tagName === "VIDEO" ? "VIDEO" : "IMG";
    if (!previewEl || previewEl.tagName !== wanted) {
      previewEl?.remove();
      previewEl = document.createElement(wanted === "VIDEO" ? "video" : "img");
      if (wanted === "VIDEO") {
        previewEl.muted = true;
        previewEl.loop = true;
        previewEl.autoplay = true;
        previewEl.playsInline = true;
      } else {
        previewEl.alt = "";
        previewEl.draggable = false;
      }
      frameEl.append(previewEl);
    }

    // Reuse the live media URL so the browser serves it straight from cache.
    const src = sourceEl.currentSrc || sourceEl.src;
    if (src && previewEl.getAttribute("src") !== src) {
      previewEl.setAttribute("src", src);
      if (wanted === "VIDEO") previewEl.play?.().catch(() => {});
    }

    styleElement(previewEl, m);
    updatePreviewAspect();
  }

  function syncControls() {
    if (!zoomSlider) return;
    const value = Math.round(frame.zoom * 100);
    if (Number(zoomSlider.value) !== value) zoomSlider.value = String(value);
    if (zoomValue) zoomValue.textContent = `${frame.zoom.toFixed(2)}×`;
    // Closed drawers must still say whether the picture is framed off-centre.
    cropToggle?.classList.toggle("on", !isIdentity(frame));
  }

  /* -------------------------------------------------------------- gestures  */

  function previewElementSize() {
    const source = primaryMedia();
    const m = source ? metrics(source) : null;
    if (!m || !frameEl) return null;
    const box = frameEl.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    return { w: box.width * m.a, h: box.height * m.b };
  }

  function onPointerDown(event) {
    if (event.button !== 0 || block?.dataset.bgcEmpty === "true") return;
    if (!previewElementSize()) return;
    dragging = { id: event.pointerId, x: event.clientX, y: event.clientY, tx: frame.tx, ty: frame.ty };
    frameEl.dataset.dragging = "true";
    frameEl.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  function onPointerMove(event) {
    if (!dragging || event.pointerId !== dragging.id) return;
    const size = previewElementSize();
    if (!size) return;
    const dx = event.clientX - dragging.x;
    const dy = event.clientY - dragging.y;
    // tx/ty are percentages of the *element*, so convert the drag through the
    // preview's rendered element size — the same percentages drive the real one.
    frame.tx = dragging.tx + (dx / size.w) * 100;
    frame.ty = dragging.ty + (dy / size.h) * 100;
    apply();
  }

  function onPointerUp(event) {
    if (!dragging || event.pointerId !== dragging.id) return;
    dragging = null;
    if (frameEl) {
      delete frameEl.dataset.dragging;
      frameEl.releasePointerCapture?.(event.pointerId);
    }
    scheduleSave();
  }

  // Zoom is slider-only on purpose. A wheel handler here meant a stray scroll
  // over the preview silently rescaled the wallpaper, and the drawer exists
  // precisely to keep framing out of the way of ordinary scrolling.

  /* ------------------------------------------------------ transparency UI  */

  let uiBlock = null;
  let sidebarButton = null;
  let edgeButton = null;
  let densitySlider = null;
  let densityValue = null;

  const RESET_ICON =
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M13.2 10.4A5.6 5.6 0 1 1 12.9 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
    '<path d="M13.9 1.7 13.2 5.2l-3.5-.7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    "</svg>";

  function formatDensity(value) {
    return `${Math.round(value * 100)}%`;
  }

  function syncTransparencyControls() {
    if (sidebarButton) {
      sidebarButton.textContent = settings.sidebarFollow ? "已开" : "已关";
      sidebarButton.classList.toggle("on", settings.sidebarFollow);
      sidebarButton.setAttribute("aria-pressed", settings.sidebarFollow ? "true" : "false");
    }
    if (edgeButton) {
      edgeButton.textContent = settings.edgeFill ? "已开" : "已关";
      edgeButton.classList.toggle("on", settings.edgeFill);
      edgeButton.setAttribute("aria-pressed", settings.edgeFill ? "true" : "false");
    }
    if (densitySlider) {
      const scaled = Math.round(settings.density * 100);
      if (Number(densitySlider.value) !== scaled) densitySlider.value = String(scaled);
    }
    if (densityValue) densityValue.textContent = formatDensity(settings.density);
  }

  function buildUiBlock() {
    const el = document.createElement("div");
    el.className = "bc-group";
    el.id = UI_BLOCK_ID;
    el.innerHTML =
      '<div class="bc-row"><div class="bc-row-text">' +
      '<span class="bc-row-title">侧边栏跟随内容</span>' +
      '<span class="bc-row-desc">左栏改用和右栏同一层透明度，图片不再被挡掉一块</span>' +
      "</div>" +
      '<div class="bc-control"><button type="button" class="bc-btn bc-pill" data-bgc-act="sidebar" aria-pressed="true">已开</button></div>' +
      "</div>" +
      '<div class="bc-row"><div class="bc-row-text">' +
      '<span class="bc-row-title">磨砂边缘缝合</span>' +
      '<span class="bc-row-desc">模糊改由上层背板承担，窗口四边不再透出底色；只在背景磨砂大于 0 时有区别</span>' +
      "</div>" +
      '<div class="bc-control"><button type="button" class="bc-btn bc-pill" data-bgc-act="edge" aria-pressed="false">已关</button></div>' +
      "</div>" +
      '<div class="bc-row"><div class="bc-row-text">' +
      '<span class="bc-row-title">工作时浓度</span>' +
      '<span class="bc-row-desc">开始对话后界面会变实；往左更透，往右更清楚</span>' +
      "</div>" +
      '<div class="bc-control"><span class="bgc-sliderwrap">' +
      '<input type="range" class="bgc-range" min="15" max="150" step="1" value="150" aria-label="工作时浓度"/>' +
      '<span class="bgc-value">100%</span>' +
      "</span>" +
      '<button type="button" class="bgc-reset" data-bgc-act="density-reset" aria-label="恢复默认" title="恢复默认">' +
      RESET_ICON +
      "</button></div></div>" +
      '<div class="bc-row"><div class="bc-row-text">' +
      '<span class="bc-row-title">背景轮播</span>' +
      '<span class="bc-row-desc">按间隔自动切换分组里的背景；每张背景各自的裁切会跟着走</span>' +
      "</div>" +
      '<div class="bc-control"><button type="button" class="bc-btn bc-pill" data-bgc-act="carousel-toggle"' +
      ' aria-expanded="false" aria-controls="bgc-carousel-body">设置</button></div>' +
      "</div>" +
      '<div class="bgc-body" id="bgc-carousel-body" hidden>' +
      '<p class="bgc-hint" data-bgc-carousel="hint" hidden></p>' +
      '<div class="bgc-crow"><span class="bgc-clabel">分组</span>' +
      '<select class="bgc-cselect" data-bgc-carousel="group" aria-label="轮播分组"></select>' +
      '<button type="button" class="bc-btn bc-pill bgc-cmini" data-bgc-carousel="new">新建</button>' +
      '<button type="button" class="bc-btn bc-pill bgc-cmini" data-bgc-carousel="remove">删除</button></div>' +
      '<div class="bgc-crow"><span class="bgc-clabel">名称</span>' +
      '<input type="text" class="bgc-cinput" data-bgc-carousel="name" maxlength="60" aria-label="分组名称"/></div>' +
      '<div class="bgc-crow"><span class="bgc-clabel">间隔</span>' +
      '<input type="range" class="bgc-range bgc-crange" data-bgc-carousel="interval" min="5" max="600" step="5" value="60" aria-label="切换间隔"/>' +
      '<span class="bgc-value" data-bgc-carousel="interval-value">60 秒</span></div>' +
      '<div class="bgc-crow"><span class="bgc-clabel">轮播</span>' +
      '<button type="button" class="bc-btn bc-pill bgc-cmini" data-bgc-carousel="enable" aria-pressed="false">未启用</button>' +
      '<span class="bgc-cstatus" data-bgc-carousel="status"></span></div>' +
      '<div class="bgc-crow"><span class="bgc-clabel">顺序</span>' +
      '<button type="button" class="bc-btn bc-pill bgc-cmini" data-bgc-carousel="order" aria-pressed="false">顺序播放</button>' +
      '<button type="button" class="bc-btn bc-pill bgc-cmini" data-bgc-carousel="next">下一张</button></div>' +
      '<div class="bgc-crow bgc-crow-top"><span class="bgc-clabel">背景</span>' +
      '<div class="bgc-citems" data-bgc-carousel="items"></div></div>' +
      '<div class="bgc-crow"><span class="bgc-clabel">添加</span>' +
      '<select class="bgc-cselect" data-bgc-carousel="add" aria-label="可添加的背景"></select>' +
      '<button type="button" class="bc-btn bc-pill bgc-cmini" data-bgc-carousel="add-btn">加入</button></div>' +
      "</div>" +
      '<div class="bc-row"><div class="bc-row-text">' +
      '<span class="bc-row-title">刷新页面</span>' +
      '<span class="bc-row-desc">插件或外观改动后需要刷新才会生效</span>' +
      "</div>" +
      '<div class="bc-control"><button type="button" class="bc-btn bc-pill" data-bgc-act="reload">刷新</button></div></div>';

    sidebarButton = el.querySelector('[data-bgc-act="sidebar"]');
    edgeButton = el.querySelector('[data-bgc-act="edge"]');
    densitySlider = el.querySelector(".bgc-range");
    densityValue = el.querySelector(".bgc-value");

    sidebarButton.addEventListener("click", () => {
      settings.sidebarFollow = !settings.sidebarFollow;
      applySettings();
      writeSettings();
      syncTransparencyControls();
    });

    edgeButton.addEventListener("click", () => {
      settings.edgeFill = !settings.edgeFill;
      applySettings();
      writeSettings();
      syncTransparencyControls();
    });

    densitySlider.addEventListener("input", () => {
      const next = Number(densitySlider.value) / 100;
      if (!Number.isFinite(next)) return;
      settings.density = Math.min(DENSITY_MAX, Math.max(DENSITY_MIN, next));
      applySettings();
      writeSettings();
      syncTransparencyControls();
    });

    el.querySelector('[data-bgc-act="density-reset"]').addEventListener("click", () => {
      settings.density = DENSITY_DEFAULT;
      applySettings();
      writeSettings();
      syncTransparencyControls();
    });

    // The Windows desktop shell has no reload menu, no reload accelerator and
    // no reload command in the shortcut registry, so this is the only in-app
    // way to pick up a plugin change.
    el.querySelector('[data-bgc-act="reload"]').addEventListener("click", () => {
      location.reload();
    });

    wireCarousel(el);
    // buildUiBlock is the only place the block is guaranteed to exist: it is
    // injected into the console page, which is not mounted when boot runs.
    watchPanelVisibility(el);


    return el;
  }

  /* -------------------------------------------------------- carousel (client) */

  const CAROUSEL_URL = '/__beauticode/ui/carousel';
  const CAROUSEL_PRESETS = [
    { id: 'internal', name: 'Internal' },
    { id: 'infernal', name: 'Infernal' },
  ];

  let carouselState = null;    // last snapshot from the host
  let carouselThemes = [];     // saved themes, refreshed with the identity
  let carouselEditId = null;   // the group being edited, not necessarily active
  let carouselBusy = false;
  let carouselEl = null;

  function carouselHeaders(extra) {
    const desktopKey = globalThis.__BEAUTICODE_DESKTOP_KEY__;
    const base = typeof desktopKey === 'string' ? { 'x-beauticode-desktop-key': desktopKey } : {};
    return Object.assign({}, base, extra || {});
  }

  async function carouselRequest(path, body) {
    const init = { credentials: 'same-origin', headers: carouselHeaders() };
    if (body !== undefined) {
      init.method = 'POST';
      init.headers = carouselHeaders({ 'content-type': 'application/json' });
      init.body = JSON.stringify(body);
    }
    let response = null;
    let payload = null;
    try {
      response = await fetch(path, init);
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!payload || typeof payload !== 'object') {
      // A 404 here is nearly always the host still running the previous build:
      // these routes live in index.mjs, which only loads when the process
      // starts. Saying "no response" would point the user the wrong way.
      const status = response ? response.status : 0;
      if (status === 404) {
        return { ok: false, error: '轮播路由还没注册 —— 完全退出并重启 DSH 后才生效。' };
      }
      if (status === 403) {
        return { ok: false, error: '同源校验未通过，刷新页面后重试。' };
      }
      return { ok: false, error: '宿主没有响应。' };
    }
    // Mutations nest the refreshed state under `state`; the GET route returns it
    // flat. Accepting only the flat form left the local copy stale after every
    // create, delete and activate, so the panel kept rendering the old list and
    // the action looked like it had done nothing.
    const refreshed = Array.isArray(payload.groups) ? payload : payload.state;
    if (refreshed && Array.isArray(refreshed.groups)) carouselState = refreshed;
    return payload;
  }

  function carouselGroups() {
    return carouselState && Array.isArray(carouselState.groups) ? carouselState.groups : [];
  }

  function carouselEditing() {
    const groups = carouselGroups();
    if (groups.length === 0) return null;
    const explicit = groups.find((group) => group.id === carouselEditId);
    if (explicit) return explicit;
    // Default to whatever is rotating: opening the drawer should show the live
    // group, not whichever one happens to be first in storage.
    const active = carouselState && carouselState.activeGroupId;
    return groups.find((group) => group.id === active) || groups[0];
  }

  /** Label for an item, marking references whose target no longer exists. */
  function carouselItemLabel(item) {
    if (item.kind === 'preset') {
      const preset = CAROUSEL_PRESETS.find((entry) => entry.id === item.id);
      return { text: preset ? preset.name : item.id, missing: !preset };
    }
    const theme = carouselThemes.find((entry) => entry.id === item.id);
    return { text: theme ? theme.name : item.id, missing: !theme };
  }

  /** Options the add picker offers: saved themes first, then built-in presets. */
  function carouselCandidates() {
    const options = [];
    for (const theme of carouselThemes) options.push({ value: 'theme:' + theme.id, label: theme.name });
    for (const preset of CAROUSEL_PRESETS) options.push({ value: 'preset:' + preset.id, label: preset.name + '（内置）' });
    return options;
  }

  function carouselOption(value, label, selected) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    if (selected) option.selected = true;
    return option;
  }

  function carouselHint(message) {
    if (!carouselEl) return;
    const el = carouselEl.querySelector('[data-bgc-carousel=hint]');
    if (!el) return;
    el.hidden = !message;
    el.textContent = message || '';
  }

  async function carouselSave(patch) {
    const group = carouselEditing();
    if (!group) return;
    if (carouselBusy) return;
    carouselBusy = true;
    try {
      const payload = await carouselRequest(CAROUSEL_URL + '/group', {
        id: group.id,
        name: patch.name !== undefined ? patch.name : group.name,
        intervalMs: patch.intervalMs !== undefined ? patch.intervalMs : group.intervalMs,
        order: patch.order !== undefined ? patch.order : group.order,
        items: patch.items !== undefined ? patch.items : group.items,
      });
      if (!payload.ok) carouselHint(payload.error || '保存失败。');
      else carouselHint('');
      renderCarousel();
    } finally {
      carouselBusy = false;
    }
  }

  function renderCarousel() {
    if (!carouselEl) return;
    const groupSelect = carouselEl.querySelector('[data-bgc-carousel=group]');
    const nameInput = carouselEl.querySelector('[data-bgc-carousel=name]');
    const interval = carouselEl.querySelector('[data-bgc-carousel=interval]');
    const intervalValue = carouselEl.querySelector('[data-bgc-carousel=interval-value]');
    const enable = carouselEl.querySelector('[data-bgc-carousel=enable]');
    const status = carouselEl.querySelector('[data-bgc-carousel=status]');
    const items = carouselEl.querySelector('[data-bgc-carousel=items]');
    const add = carouselEl.querySelector('[data-bgc-carousel=add]');
    if (!groupSelect || !items || !add) return;

    const groups = carouselGroups();
    const group = carouselEditing();
    if (group) carouselEditId = group.id;

    // groups
    groupSelect.textContent = '';
    if (groups.length === 0) {
      groupSelect.append(carouselOption('', '还没有分组', true));
    } else {
      for (const entry of groups) groupSelect.append(carouselOption(entry.id, entry.name, group && entry.id === group.id));
    }

    // fields
    if (nameInput) {
      nameInput.disabled = !group;
      if (document.activeElement !== nameInput) nameInput.value = group ? group.name : '';
    }
    if (interval) {
      interval.disabled = !group;
      const seconds = group ? Math.round(group.intervalMs / 1000) : 60;
      if (document.activeElement !== interval) interval.value = String(Math.min(600, Math.max(5, seconds)));
      if (intervalValue) intervalValue.textContent = seconds >= 60 ? Math.round(seconds / 60) + ' 分' : seconds + ' 秒';
    }

    // activation
    const active = carouselState && carouselState.activeGroupId;
    if (enable) {
      enable.disabled = !group || group.items.length === 0;
      const on = Boolean(active && group && active === group.id);
      enable.setAttribute('aria-pressed', on ? 'true' : 'false');
      enable.textContent = on ? '轮播中' : '未启用';
    }
    if (status) {
      if (!active) status.textContent = group ? '共 ' + group.items.length + ' 张' : '';
      else {
        const activeGroup = groups.find((entry) => entry.id === active);
        const total = activeGroup ? activeGroup.items.length : 0;
        // cursor is the index the next tick will show, so it is not "what is
        // on screen". Reporting it as the current item was wrong before the
        // first apply (nothing is showing yet) and after it (the cursor has
        // already moved on). Say what is next instead.
        const cursor = carouselState && Number.isFinite(carouselState.cursor) ? carouselState.cursor : 0;
        status.textContent = total
          ? '轮播中 · 下一张：第 ' + (cursor + 1) + ' / ' + total + ' 张'
          : '轮播中';
        // While a group is active the carousel owns the background: picking one from
        // the list goes through the same useTheme path and does not stop it, so the
        // next tick replaces the pick. That is intended, but nothing said so.
        status.textContent += '（手动选择会在下一张被覆盖）';
      }
    }

    // order + manual advance
    const order = carouselEl.querySelector('[data-bgc-carousel=order]');
    if (order) {
      order.disabled = !group;
      const shuffle = Boolean(group && group.order === 'shuffle');
      order.setAttribute('aria-pressed', shuffle ? 'true' : 'false');
      order.textContent = shuffle ? '随机播放' : '顺序播放';
    }
    const nextButton = carouselEl.querySelector('[data-bgc-carousel=next]');
    if (nextButton) nextButton.disabled = !(carouselState && carouselState.activeGroupId);

    // items
    items.textContent = '';
    if (!group || group.items.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'bgc-cempty';
      empty.textContent = group ? '还没有背景，从下面添加' : '先新建一个分组';
      items.append(empty);
    } else {
      group.items.forEach((item, index) => {
        const labelled = carouselItemLabel(item);
        const row = document.createElement('div');
        row.className = 'bgc-citem' + (labelled.missing ? ' is-missing' : '');
        const name = document.createElement('span');
        name.className = 'bgc-citem-name';
        name.textContent = labelled.text + (labelled.missing ? '（已不存在）' : '');
        row.append(name);
        const actions = [
          { op: 'up', glyph: '↑', title: '上移', disabled: index === 0 },
          { op: 'down', glyph: '↓', title: '下移', disabled: index === group.items.length - 1 },
          { op: 'remove', glyph: '✕', title: '移出', disabled: false },
        ];
        for (const action of actions) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'bgc-cbtn';
          button.dataset.op = action.op;
          button.dataset.index = String(index);
          button.title = action.title;
          button.setAttribute('aria-label', action.title);
          button.textContent = action.glyph;
          button.disabled = action.disabled;
          row.append(button);
        }
        items.append(row);
      });
    }

    // add picker
    const candidates = carouselCandidates();
    add.textContent = '';
    if (candidates.length === 0) {
      add.append(carouselOption('', '还没有可添加的背景', true));
    } else {
      for (const candidate of candidates) add.append(carouselOption(candidate.value, candidate.label, false));
    }
    add.disabled = !group || candidates.length === 0;
    const addButton = carouselEl.querySelector('[data-bgc-carousel=add-btn]');
    if (addButton) addButton.disabled = add.disabled;
  }

  async function loadCarousel() {
    const payload = await carouselRequest(CAROUSEL_URL);
    if (!payload.ok) carouselHint(payload.error || '无法读取轮播配置。');
    renderCarousel();
  }

  function wireCarousel(root) {
    carouselEl = root.querySelector('#bgc-carousel-body');
    if (!carouselEl) return;
    const toggle = root.querySelector('[data-bgc-act=carousel-toggle]');
    if (toggle) {
      toggle.addEventListener('click', () => {
        const open = carouselEl.hidden;
        carouselEl.hidden = !open;
        toggle.textContent = open ? '收起' : '设置';
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) void loadCarousel();
      });
    }

    const groupSelect = carouselEl.querySelector('[data-bgc-carousel=group]');
    if (groupSelect) {
      groupSelect.addEventListener('change', () => {
        carouselEditId = groupSelect.value || null;
        renderCarousel();
      });
    }

    const newButton = carouselEl.querySelector('[data-bgc-carousel=new]');
    if (newButton) {
      newButton.addEventListener('click', async () => {
        if (carouselBusy) return;
        carouselBusy = true;
        try {
          const payload = await carouselRequest(CAROUSEL_URL + '/group', {
            name: '新分组',
            intervalMs: 60000,
            order: 'sequential',
            items: [],
          });
          if (payload.ok && payload.group) carouselEditId = payload.group.id;
          else carouselHint(payload.error || '新建失败。');
        } finally {
          carouselBusy = false;
        }
        renderCarousel();
      });
    }

    const removeButton = carouselEl.querySelector('[data-bgc-carousel=remove]');
    if (removeButton) {
      removeButton.addEventListener('click', async () => {
        const group = carouselEditing();
        if (!group) return;
        const payload = await carouselRequest(CAROUSEL_URL + '/delete', { id: group.id });
        if (!payload.ok) carouselHint(payload.error || '删除失败。');
        carouselEditId = null;
        renderCarousel();
      });
    }

    const nameInput = carouselEl.querySelector('[data-bgc-carousel=name]');
    if (nameInput) {
      nameInput.addEventListener('change', () => {
        const name = nameInput.value.trim();
        if (!name) { carouselHint('名称不能为空。'); renderCarousel(); return; }
        void carouselSave({ name });
      });
    }

    const interval = carouselEl.querySelector('[data-bgc-carousel=interval]');
    if (interval) {
      // Label live, persist on release: saving on every input tick would write
      // the manifest dozens of times during one drag.
      interval.addEventListener('input', () => {
        const seconds = Number(interval.value);
        const label = carouselEl.querySelector('[data-bgc-carousel=interval-value]');
        if (label && Number.isFinite(seconds)) label.textContent = seconds >= 60 ? Math.round(seconds / 60) + ' 分' : seconds + ' 秒';
      });
      interval.addEventListener('change', () => {
        const seconds = Number(interval.value);
        if (Number.isFinite(seconds)) void carouselSave({ intervalMs: Math.round(seconds * 1000) });
      });
    }

    const enable = carouselEl.querySelector('[data-bgc-carousel=enable]');
    if (enable) {
      enable.addEventListener('click', async () => {
        const group = carouselEditing();
        if (!group) return;
        const active = carouselState && carouselState.activeGroupId;
        const turningOff = active === group.id;
        const payload = await carouselRequest(CAROUSEL_URL + '/activate', { id: turningOff ? null : group.id });
        if (!payload.ok) {
          carouselHint(payload.error || '切换失败。');
        } else {
          carouselHint('');
          // Enabling only arms the timer, and the first tick is a whole
          // interval away — with a long interval the wallpaper would sit on
          // whatever was there before while the panel claimed it was rotating.
          // Show the first item now, through the same route 下一张 uses.
          if (!turningOff) await carouselRequest(CAROUSEL_URL + '/next', {});
        }
        renderCarousel();
      });
    }

    const order = carouselEl.querySelector('[data-bgc-carousel=order]');
    if (order) {
      order.addEventListener('click', () => {
        const group = carouselEditing();
        if (!group) return;
        void carouselSave({ order: group.order === 'shuffle' ? 'sequential' : 'shuffle' });
      });
    }

    const nextButton = carouselEl.querySelector('[data-bgc-carousel=next]');
    if (nextButton) {
      nextButton.addEventListener('click', async () => {
        const payload = await carouselRequest(CAROUSEL_URL + '/next', {});
        if (!payload.ok) carouselHint(payload.error || '切换失败。');
        renderCarousel();
      });
    }

    const add = carouselEl.querySelector('[data-bgc-carousel=add]');
    const addButton = carouselEl.querySelector('[data-bgc-carousel=add-btn]');
    if (add && addButton) {
      addButton.addEventListener('click', () => {
        const group = carouselEditing();
        const value = add.value;
        if (!group || !value) return;
        const separator = value.indexOf(':');
        const kind = value.slice(0, separator);
        const id = value.slice(separator + 1);
        void carouselSave({ items: group.items.concat([{ kind, id }]) });
      });
    }

    const items = carouselEl.querySelector('[data-bgc-carousel=items]');
    if (items) {
      items.addEventListener('click', (event) => {
        const button = event.target.closest('.bgc-cbtn');
        if (!button || !items.contains(button)) return;
        const group = carouselEditing();
        if (!group) return;
        const index = Number(button.dataset.index);
        if (!Number.isSafeInteger(index) || index < 0 || index >= group.items.length) return;
        const next = group.items.slice();
        if (button.dataset.op === 'remove') next.splice(index, 1);
        else if (button.dataset.op === 'up' && index > 0) next.splice(index - 1, 0, next.splice(index, 1)[0]);
        else if (button.dataset.op === 'down' && index < next.length - 1) next.splice(index + 1, 0, next.splice(index, 1)[0]);
        else return;
        void carouselSave({ items: next });
      });
    }
  }
  /* ---------------------------------------------------- panel lifecycle */

  /**
   * Close one drawer, looking it up from the panel's root node.
   *
   * The two drawers live in SIBLING blocks: #bgc-block holds the crop drawer and
   * #bgc-ui-block holds the carousel one, while this is driven from the UI block.
   * Searching that block for #bgc-crop-body could never match a node in its
   * sibling, so the lookup has to go through the root.
   *
   * getRootNode() also keeps it correct if the panel ever sits inside a shadow
   * root, where document.getElementById cannot reach it.
   */
  function collapseDrawer(block, act, bodySelector, label) {
    const root = (block && block.getRootNode()) || document;
    const body = root.querySelector(bodySelector);
    if (!body || body.hidden) return;
    body.hidden = true;
    const toggle = root.querySelector('[data-bgc-act=' + act + ']');
    if (toggle) {
      toggle.textContent = label;
      toggle.setAttribute('aria-expanded', 'false');
    }
  }

  /**
   * Collapse the drawers when the panel is shown again.
   *
   * Two independent triggers on purpose, because either can be defeated alone:
   *
   * The console announces `bgc:page-opened` when it turns its page on. That is
   * the precise signal, but it only exists at the two places the console does
   * that, and there is no guarantee every reopen path goes through one.
   *
   * The IntersectionObserver needs no cooperation at all: an element under a
   * display:none ancestor reports not-intersecting, and the page is hidden that
   * way rather than destroyed. An earlier attempt used exactly this and never
   * ran — not because the signal is wrong, but because it was registered from
   * boot via document.getElementById, which returns null for this block: it is
   * injected inside a shadow root, where getElementById cannot reach. Here the
   * element is handed over directly, so there is no lookup to fail.
   *
   * collapseDrawer is idempotent, so both firing costs nothing.
   */
  function watchPanelVisibility(block) {
    if (!block) return;
    // Registering once is what keeps a rebuild from stacking duplicates.
    if (block.dataset.bgcPanelWatch === '1') return;
    block.dataset.bgcPanelWatch = '1';
    const collapse = () => {
      collapseDrawer(block, 'crop-toggle', '#bgc-crop-body', '调整');
      collapseDrawer(block, 'carousel-toggle', '#bgc-carousel-body', '设置');
    };
    document.addEventListener('bgc:page-opened', collapse);
    if (typeof IntersectionObserver !== 'function') return;
    let seen = false;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          if (!seen) collapse();
          seen = true;
        } else {
          seen = false;
        }
      }
    });
    observer.observe(block);
  }

  /* -------------------------------------------------- composer card surface */

  /**
   * Tag the sidebar's primary action (新会话).
   *
   * Found by shape, not by name: its class is a build hash and its label changes
   * with the locale. Inside the sidebar column, the widest button that paints its
   * own background and has a rounded corner is that pill.
   */
  function tagSidebarAction() {
    const column = document.querySelector('[class*="_sidebarCol"]');
    if (!column) return;
    const columnWidth = column.getBoundingClientRect().width;
    let chosen = null;
    for (const button of column.querySelectorAll("button")) {
      const rect = button.getBoundingClientRect();
      if (rect.width < columnWidth * 0.6 || rect.height < 28) continue;
      const style = getComputedStyle(button);
      if (style.backgroundColor === "rgba(0, 0, 0, 0)") continue;
      if (parseFloat(style.borderRadius) <= 0) continue;
      if (chosen === null || rect.width > chosen.width) chosen = { button, width: rect.width };
    }
    if (chosen === null) return;
    if (chosen.button.dataset.bgcSidebarAction !== "1") chosen.button.dataset.bgcSidebarAction = "1";
  }
  /**
   * Tag the account row at the foot of the sidebar (the one showing the user name).
   *
   * Found by position: the lowest control in the sidebar column that still spans a
   * reasonable share of its width. Neither the class nor the label is usable — the
   * class is a build hash and the label is the user's own name.
   */
  function tagSidebarAccount() {
    const column = document.querySelector('[class*="_sidebarCol"]');
    if (!column) return;
    const columnWidth = column.getBoundingClientRect().width;
    let chosen = null;
    for (const el of column.querySelectorAll('button, [role="button"]')) {
      const rect = el.getBoundingClientRect();
      if (rect.width < columnWidth * 0.5) continue;
      if (rect.height < 28 || rect.height > 120) continue;
      if (chosen === null || rect.top > chosen.top) chosen = { el, top: rect.top };
    }
    if (chosen === null) return;
    if (chosen.el.dataset.bgcSidebarAccount !== "1") chosen.el.dataset.bgcSidebarAccount = "1";
  }
  /**
   * Tag the composer card — the composer card normally, the question card while
   * DSH is asking something.
   *
   * The search runs over the SEAT: with a question on screen the composer stack
   * is still present but empty, so searching it found nothing at all, and the
   * input itself is removed from the DOM, so walking up from it has no chain to
   * climb. The seat holds whichever of the two is currently rendered.
   *
   * The width floor is relative to the widest candidate rather than to the
   * container: a seat-relative ratio excluded the 680px question card inside a
   * seat roughly twice that wide. Buttons, chips and option rows sit inside the
   * card, so they are narrower and drop out on their own.
   */
  // The element currently carrying the frost. Kept until it stops being valid, so
  // the tag cannot hop between the card and a wrapper inside it on every re-scan.
  let frostedEl = null;
  let lastAreaSize = -1;

  function tagComposerSurface() {
    const area =
      document.querySelector('[class*="_composerSeat"]') ??
      document.querySelector('[class*="_composerStack"]');
    if (!area) return;

    // The gate is the AREA, not the target.
    //
    // Gating on the target kept the frost on a node that was no longer the card. The
    // composer stack survives a question with its children removed, and entering the
    // selection state swaps which element is the card — both are recorded elsewhere in
    // this file. Either way the card lost its frost, which reads as transparent.
    //
    // Counting the area's descendants is a walk, not a layout read, so the gate stays
    // as cheap as it was. An unchanged count means nothing in the area changed shape
    // and the current choice stands. A changed count means re-decide — and 5.3.3's
    // outermost-only rule makes re-deciding return one stable element, so this no
    // longer hops.
    const areaSize = area.querySelectorAll("*").length;
    if (
      frostedEl &&
      frostedEl.isConnected &&
      area.contains(frostedEl) &&
      frostedEl.dataset.bgcComposer === "1" &&
      areaSize === lastAreaSize
    ) {
      return;
    }
    lastAreaSize = areaSize;
    const candidates = [];
    for (const el of area.querySelectorAll("*")) {
      const rect = el.getBoundingClientRect();
      if (rect.height < 40 || rect.width < 160) continue;
      const style = getComputedStyle(el);
      if (style.backgroundColor === "rgba(0, 0, 0, 0)") continue;
      if (parseFloat(style.borderRadius) <= 0) continue;
      candidates.push({ el, width: rect.width });
    }
    if (candidates.length === 0) return;
    const widest = Math.max(...candidates.map((c) => c.width));
    const qualifying = candidates.filter((c) => c.width >= widest * 0.6);

    // Exactly one element carries the frost.
    //
    // backdrop-filter nests: with the tag on a container AND on a same-width wrapper
    // inside it, what shows through is blurred twice under two 55% surfaces, and a
    // glyph behind it reads as doubled — the overlapping text. It also creates a
    // containing block, so position:fixed descendants get re-anchored to the tagged
    // element, which is the shifting. Keeping only the outermost qualifying element
    // covers the card once with nothing nested inside it carrying a second filter.
    const outermost = qualifying.filter(
      (c) => !qualifying.some((other) => other !== c && other.el.contains(c.el)),
    );
    const chosen = outermost.reduce((a, b) => (a && a.width >= b.width ? a : b));
    const next = new Set([chosen.el]);
    for (const el of document.querySelectorAll('[data-bgc-composer="1"]')) {
      if (!next.has(el)) delete el.dataset.bgcComposer;
    }
    for (const el of next) {
      if (el.dataset.bgcComposer !== "1") el.dataset.bgcComposer = "1";
      frostedEl = el;
    }
  }

  /* ---------------------------------------------------- native caption strip */

  /** Appending to <head> is what the preload observes to re-read the probe. */
  function nudgeHead() {
    document.getElementById("bgc-nudge")?.remove();
    const nudge = document.createElement("style");
    nudge.id = "bgc-nudge";
    nudge.textContent = "/* bgc: re-measure the caption probe */";
    document.head.append(nudge);
  }

  /**
   * Tag the preload's anonymous probe span so the stylesheet can repaint it.
   * It carries no class or id, so it is recognised by the inline style the
   * preload writes — with whitespace stripped, because cssText is serialised
   * with a space after every colon.
   */
  function tagCaptionProbe() {
    if (!document.documentElement.hasAttribute("data-windows-titlebar")) return;
    const body = document.body;
    if (!body) return;
    for (const el of body.children) {
      if (el.dataset?.bgcProbe === "1") return;
    }
    for (const el of body.children) {
      if (el.tagName !== "SPAN" || !el.dataset) continue;
      const style = (el.getAttribute("style") ?? "").replace(/\s+/g, "");
      if (!style.includes("visibility:hidden")) continue;
      if (!style.includes("--dsw-specific-sidebar-fill")) continue;
      el.dataset.bgcProbe = "1";
      nudgeHead();
      return;
    }
  }

  /* ------------------------------------------------------------- mounting   */

  let mountQueued = false;
  function ensureBlocks() {
    if (mountQueued) return;
    mountQueued = true;
    requestAnimationFrame(() => {
      mountQueued = false;
      const page = document.getElementById(PAGE_ID);
      if (!page) return;
      if (block && uiBlock && page.contains(block) && page.contains(uiBlock)) return;

      if (!block) block = buildBlock();
      if (!uiBlock) uiBlock = buildUiBlock();

      // Sit directly after beautiCode's first group (fullscreen / dim / blur / sound).
      const firstGroup = page.querySelector(".bc-group");
      if (firstGroup && firstGroup.parentElement === page) {
        firstGroup.after(block);
        block.after(uiBlock);
      } else {
        page.append(block, uiBlock);
      }
      syncTransparencyControls();
      updatePreviewAspect();
      apply();
    });
  }

  function startPageObserver() {
    // The observer spans the whole document, so it fires for every node the app
    // inserts anywhere — including every chunk of a streaming reply. Its callback
    // runs three functions that measure geometry: tagComposerSurface walks every
    // descendant of the composer area calling getBoundingClientRect, and the two
    // sidebar taggers do the same per button. Forced synchronous layout at that rate
    // is what made the window visibly stutter while a reply was streaming.
    //
    // All three are cosmetic — they move the frost and the button material onto the
    // right elements — so they do not need to run on every mutation. One pass per
    // frame would not have been enough either, because a streaming reply mutates on
    // essentially every frame; a minimum interval is what bounds the work. The
    // trailing pass guarantees the settled state is always the tagged one.
    const COOLDOWN_MS = 200;
    let pending = false;
    let lastRun = 0;
    let timer = null;

    const run = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pending = false;
      lastRun = Date.now();
      ensureBlocks();
      tagCaptionProbe();
      tagComposerSurface();
      tagSidebarAction();
      tagSidebarAccount();
    };

    const onMutation = () => {
      if (pending) return;
      pending = true;
      const elapsed = Date.now() - lastRun;
      if (elapsed >= COOLDOWN_MS) requestAnimationFrame(run);
      else timer = setTimeout(run, COOLDOWN_MS - elapsed);
    };

    const observer = new MutationObserver(onMutation);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      // Composer state switches are class/attribute only. Watching childList
      // alone meant tagComposerSurface never re-ran when the input entered its
      // selection state, so the tag stayed on the old element and the card lost
      // its frost — which read as the input going transparent again.
      attributes: true,
      attributeFilter: ["class", "data-state", "hidden", "aria-expanded", "aria-hidden"],
    });
    run();
    // The picker needs the saved-theme list, which arrives with the identity.
    void loadCarousel();
  }

  /* ------------------------------------------------------------------ boot  */

  function boot() {
    ensureStyle("bgc-style", CROP_STYLE + UI_STYLE + TRANSPARENCY_STYLE);
    applySettings();
    startPageObserver();
    startStageObserver();
    // Same order as the observer: the frame for the current identity has to be
    // loaded before anything is painted, or the first paint uses the previous
    // background's crop and visibly corrects itself.
    void refreshIdentity({ applyAfter: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
