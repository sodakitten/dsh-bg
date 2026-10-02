export function normalizeBackgroundEffects(value) {
    if (!value || typeof value !== "object")
        return null;
    const preset = value.preset;
    if (preset !== "internal" &&
        preset !== "infernal" &&
        preset !== "gallery") {
        return null;
    }
    return { preset, rain: true, overlay: true, water: true };
}
export function effectsForPreset(preset) {
    return { preset, rain: true, overlay: true, water: true };
}
//# sourceMappingURL=types.js.map