import path from "node:path";
import { assertSafeBasename } from "./media-validation.js";
/** Resolve a manifest source against the directory that owns managed files. */
export function resolveMediaSource(source, ownerDir) {
    if (source.kind === "local")
        return path.resolve(source.path);
    assertSafeBasename(source.file, "background.source.file");
    return path.join(ownerDir, source.file);
}
/** Resolve the primary image source, including legacy v1 manifests. */
export function resolveBackgroundImagePath(ownerDir, background) {
    if (background.type === "image" && background.source) {
        return resolveMediaSource(background.source, ownerDir);
    }
    return background.image ? path.join(ownerDir, background.image) : null;
}
/** Resolve the primary video source, including legacy v1 manifests. */
export function resolveBackgroundVideoPath(ownerDir, background) {
    if (background.type !== "video")
        return null;
    if (background.source)
        return resolveMediaSource(background.source, ownerDir);
    return background.video ? path.join(ownerDir, background.video) : null;
}
export function isLocalBackgroundSource(background) {
    return background.source?.kind === "local";
}
/** Return the managed primary filename when a snapshot/theme must copy it. */
export function managedPrimaryFile(background) {
    if (background.source?.kind === "managed")
        return background.source.file;
    if (background.source?.kind === "local")
        return null;
    return background.type === "image"
        ? background.image ?? null
        : background.video ?? null;
}
//# sourceMappingURL=media-source.js.map