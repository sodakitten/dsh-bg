/**
 * Background carousel.
 *
 * Rotates the active background through a user-defined group of backgrounds that
 * are ALREADY in the library. Design notes, since several of these are the
 * decisions that make the feature safe rather than the obvious first move:
 *
 * 1. References, not copies.
 *    An item points at an existing saved theme (`kind: "theme"`) or a bundled
 *    preset (`kind: "preset"`). No image bytes are duplicated, so the same 12MB
 *    background can sit in five groups and still occupy one copy on disk. The
 *    cost is dangling references — a theme deleted while a group still lists it —
 *    which are skipped at tick time and reported, instead of being hidden behind
 *    a stale copy that silently keeps working after the user deleted it.
 *
 * 2. One active group.
 *    The background is a single global resource, so "two groups enabled" cannot
 *    mean anything. `activeGroupId` is therefore a scalar and activating one
 *    group stops any other, which keeps the state unambiguous rather than
 *    leaving two timers racing to set the same background.
 *
 * 3. The cursor is persisted.
 *    A host restart resumes where rotation left off instead of snapping back to
 *    item 0, which would make the sequence look random across restarts.
 *
 * 4. Rotation drives the SAME actions the panel uses.
 *    `useTheme` / `applyPreset` are exactly what a click in the settings page
 *    calls, so every downstream guarantee — the apply transaction, the media
 *    server, the renderer verification — applies unchanged. This is also what
 *    makes framing compatibility free: the client keys each background's crop by
 *    its resolved identity, so once a switch lands the incoming background brings
 *    its own crop with it and no framing code needs to know a carousel exists.
 *
 * 5. Bounded work per tick.
 *    Missing or unloadable items are skipped, but only up to SKIP_LIMIT of them,
 *    so a group whose entries have all been deleted reports a failure instead of
 *    spinning through the list forever.
 *
 * 6. No overlapping applies.
 *    If the previous switch is still in flight when the timer fires, the tick is
 *    dropped. Applying is slow (renderer verification) and queues would pile up.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const CAROUSEL_SCHEMA = "dsh-bg.carousel/v1";
export const CAROUSEL_MIN_INTERVAL_MS = 5_000;
export const CAROUSEL_MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const CAROUSEL_DEFAULT_INTERVAL_MS = 60_000;
const MAX_GROUPS = 20;
const MAX_ITEMS = 60;
const MAX_NAME_LENGTH = 60;
const SKIP_LIMIT = 8;
const ITEM_KINDS = ["theme", "preset"];

/** A group id is opaque and stable; the name is what the user edits. */
function newGroupId() {
  return `cg-${crypto.randomBytes(6).toString("hex")}`;
}

function clampInterval(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return CAROUSEL_DEFAULT_INTERVAL_MS;
  return Math.min(CAROUSEL_MAX_INTERVAL_MS, Math.max(CAROUSEL_MIN_INTERVAL_MS, Math.round(numeric)));
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!ITEM_KINDS.includes(raw.kind)) return null;
  if (typeof raw.id !== "string" || raw.id.length < 1 || raw.id.length > 200) return null;
  return { kind: raw.kind, id: raw.id };
}

function normalizeName(raw) {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (name.length < 1 || name.length > MAX_NAME_LENGTH) return null;
  return name;
}

export function createCarousel({ dataRoot, actions, log = () => {} }) {
  const dir = path.join(dataRoot, "carousel");
  const manifestPath = path.join(dir, "groups.json");

  let state = { schema: CAROUSEL_SCHEMA, activeGroupId: null, cursor: 0, groups: [] };
  let timer = null;
  let inFlight = false;

  /* ------------------------------------------------------------ persistence */

  async function load() {
    try {
      const raw = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      const groups = Array.isArray(raw.groups)
        ? raw.groups
            .map((group) => ({
              id: typeof group?.id === "string" && /^cg-[a-f0-9]{12}$/.test(group.id) ? group.id : newGroupId(),
              name: normalizeName(group?.name) ?? "未命名",
              intervalMs: clampInterval(group?.intervalMs),
              order: group?.order === "shuffle" ? "shuffle" : "sequential",
              items: Array.isArray(group?.items)
                ? group.items.map(normalizeItem).filter(Boolean).slice(0, MAX_ITEMS)
                : [],
            }))
            .slice(0, MAX_GROUPS)
        : [];
      const activeGroupId =
        typeof raw.activeGroupId === "string" && groups.some((g) => g.id === raw.activeGroupId)
          ? raw.activeGroupId
          : null;
      const cursor = Number.isSafeInteger(raw.cursor) && raw.cursor >= 0 ? raw.cursor : 0;
      state = { schema: CAROUSEL_SCHEMA, activeGroupId, cursor, groups };
    } catch {
      // Missing or unreadable: start empty rather than failing plugin load.
      state = { schema: CAROUSEL_SCHEMA, activeGroupId: null, cursor: 0, groups: [] };
    }
    return state;
  }

  /** Write via a temp file + rename so a crash cannot leave half a manifest. */
  async function persist() {
    await fs.mkdir(dir, { recursive: true });
    const temp = path.join(dir, `groups.${process.pid}.tmp`);
    await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await fs.rename(temp, manifestPath);
  }

  /* ------------------------------------------------------------------- reads */

  function activeGroup() {
    if (!state.activeGroupId) return null;
    return state.groups.find((group) => group.id === state.activeGroupId) ?? null;
  }

  /** Public shape. `cursor` is clamped so the UI never shows a stale index. */
  function snapshot() {
    const group = activeGroup();
    const itemCount = group?.items.length ?? 0;
    return {
      schema: CAROUSEL_SCHEMA,
      activeGroupId: state.activeGroupId,
      cursor: itemCount > 0 ? state.cursor % itemCount : 0,
      groups: state.groups.map((entry) => ({ ...entry, items: [...entry.items] })),
      limits: {
        minIntervalMs: CAROUSEL_MIN_INTERVAL_MS,
        maxIntervalMs: CAROUSEL_MAX_INTERVAL_MS,
        maxGroups: MAX_GROUPS,
        maxItems: MAX_ITEMS,
        maxNameLength: MAX_NAME_LENGTH,
      },
    };
  }

  /* ------------------------------------------------------------------ writes */

  async function saveGroup(input) {
    const name = normalizeName(input?.name);
    if (!name) return { ok: false, error: "分组名不能为空，且不超过 60 个字符。" };
    const items = Array.isArray(input?.items)
      ? input.items.map(normalizeItem).filter(Boolean)
      : null;
    if (items === null) return { ok: false, error: "背景列表格式无效。" };
    if (items.length > MAX_ITEMS) return { ok: false, error: `一个分组最多 ${MAX_ITEMS} 张背景。` };

    const id = typeof input?.id === "string" ? input.id : null;
    const existing = id ? state.groups.find((group) => group.id === id) : null;
    if (id && !existing) return { ok: false, error: "找不到该分组。" };

    // An omitted field means "leave it alone", not "reset it to the default":
    // the client only sends what the user actually changed, and any other
    // reading silently reverts the rest on every edit.
    const next = {
      id: existing?.id ?? newGroupId(),
      name,
      intervalMs:
        input?.intervalMs === undefined && existing
          ? existing.intervalMs
          : clampInterval(input?.intervalMs),
      order:
        input?.order === "shuffle" || input?.order === "sequential"
          ? input.order
          : (existing?.order ?? "sequential"),
      items,
    };
    if (!existing) {
      if (state.groups.length >= MAX_GROUPS) return { ok: false, error: `最多 ${MAX_GROUPS} 个分组。` };
      state.groups.push(next);
    } else {
      state.groups = state.groups.map((group) => (group.id === next.id ? next : group));
      // The item list may have shortened under the cursor.
      if (next.items.length > 0) state.cursor %= next.items.length;
      else state.cursor = 0;
    }
    await persist();
    // An edit changes what the next tick should show, so re-arm.
    arm();
    return { ok: true, group: { ...next }, state: snapshot() };
  }

  async function deleteGroup(id) {
    const target = typeof id === "string" ? id : "";
    if (!state.groups.some((group) => group.id === target)) {
      return { ok: false, error: "找不到该分组。" };
    }
    state.groups = state.groups.filter((group) => group.id !== target);
    if (state.activeGroupId === target) {
      state.activeGroupId = null;
      state.cursor = 0;
    }
    await persist();
    arm();
    return { ok: true, state: snapshot() };
  }

  async function activate(id) {
    const target = typeof id === "string" && id.length > 0 ? id : null;
    if (target !== null && !state.groups.some((group) => group.id === target)) {
      return { ok: false, error: "找不到该分组。" };
    }
    state.activeGroupId = target;
    if (target === null) state.cursor = 0;
    await persist();
    arm();
    log(target === null ? "carousel: stopped" : `carousel: started ${target}`);
    return { ok: true, state: snapshot() };
  }

  /* ------------------------------------------------------------------ engine */

  /**
   * Where rotation goes after `index`.
   *
   * Shuffle deliberately never returns the current index: landing on the same
   * background twice in a row reads as a stutter, not as variety. Groups of one
   * have nothing else to pick, so they stay put.
   */
  function nextIndexFor(group, index, total) {
    if (total <= 1) return 0;
    if (group.order !== "shuffle") return (index + 1) % total;
    let next = index;
    while (next === index) next = Math.floor(Math.random() * total);
    return next;
  }

  /**
   * Pick the next item and apply it.
   *
   * Returns the applied item, or null when nothing could be applied. The cursor
   * advances past every item that is tried, including the ones that fail, so a
   * permanently broken entry cannot pin rotation on itself.
   */
  async function advance({ manual = false } = {}) {
    const group = activeGroup();
    if (!group || group.items.length === 0) return null;
    if (inFlight) return null;
    inFlight = true;
    try {
      const total = group.items.length;
      let index = state.cursor % total;
      for (let attempt = 0; attempt < Math.min(SKIP_LIMIT, total); attempt++) {
        const item = group.items[index];
        const nextIndex = nextIndexFor(group, index, total);
        try {
          if (item.kind === "theme") await actions.useTheme(item.id);
          else await actions.applyPreset(item.id);
          state.cursor = nextIndex;
          await persist();
          return item;
        } catch (error) {
          log(`carousel: skipped ${item.kind}:${item.id} — ${error?.message ?? error}`);
          index = nextIndex;
        }
      }
      log("carousel: no item in the active group could be applied");
      return null;
    } finally {
      inFlight = false;
    }
  }

  /** Arm or disarm the timer to match the current state. Safe to call anytime. */
  function arm() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const group = activeGroup();
    if (!group || group.items.length === 0) return;
    timer = setTimeout(async () => {
      timer = null;
      try {
        await advance();
      } catch (error) {
        log(`carousel: tick failed — ${error?.message ?? error}`);
      }
      // Re-arm from the group's CURRENT interval; an edit during the wait is
      // picked up here even if arm() raced with the tick.
      arm();
    }, group.intervalMs);
    // Never hold the host process open just for a slideshow.
    timer.unref?.();
  }

  async function start() {
    await load();
    arm();
    return snapshot();
  }

  function dispose() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return {
    start,
    dispose,
    snapshot,
    saveGroup,
    deleteGroup,
    activate,
    next: () => advance({ manual: true }),
    // exposed for tests / manual pokes
    _advance: advance,
  };
}
