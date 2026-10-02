export const SCHEMA_ID = "beauticode.background/v1";
// Images may be up to this size on disk. Codex does not embed that whole file
// in one Runtime.evaluate — oversized stills use CDP file-input → blob:.
export const MAX_IMAGE_BYTES = 18 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 800 * 1024 * 1024;
/**
 * Max raw media bytes embedded as a data: URL inside one CDP evaluate.
 * Videos use CDP file-input/blob attachment instead of this limit.
 * Codex stills above ~128KiB also skip this path (see adapter-codex payload).
 */
export const MAX_INLINE_DATA_URL_BYTES = MAX_IMAGE_BYTES;
export const COMMIT_MARKER_NAME = ".beauticode-commit-in-progress";
export const COMMIT_MARKER_STALE_MS = 120_000;
export const MEDIA_TOKEN_HEADER = "x-beauticode-media-token";
export const MEDIA_TOKEN_HEADER_CANON = "X-BeautiCode-Media-Token";
/** Default origins accepted by the loopback media server (Electron-style). */
export const DEFAULT_TRUSTED_ORIGINS = Object.freeze([
    "app://-",
    "app://",
    "null",
    // Some Electron shells report a trailing slash or empty host variants.
    "app://./",
    "file://",
]);
/**
 * Origins matching this pattern are also trusted for loopback media.
 * Only safe because the media hub binds 127.0.0.1 exclusively.
 */
export const TRUSTED_ORIGIN_PREFIXES = Object.freeze(["app://"]);
export const IMAGE_EXTENSIONS = Object.freeze([
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".avif",
]);
export const VIDEO_EXTENSIONS = Object.freeze([".mp4", ".mov"]);
/** Managed/runtime copies keep this extension; local imports may be `.mov`. */
export const VIDEO_EXTENSION = ".mp4";
export const VIDEO_MIME = "video/mp4";
export function isVideoExtension(ext) {
    return VIDEO_EXTENSIONS.includes(ext.toLowerCase());
}
export const ACTIVE_DIR_NAME = "active";
export const STAGING_DIR_NAME = "staging";
export const SNAPSHOTS_DIR_NAME = "snapshots";
export const SAVED_DIR_NAME = "saved";
export const RUNTIME_MEDIA_DIR_NAME = "runtime-media";
export const MANIFEST_NAME = "background.json";
export const SAVED_META_NAME = "theme.json";
export const DEFAULT_VIDEO_BASENAME = "background.mp4";
//# sourceMappingURL=constants.js.map