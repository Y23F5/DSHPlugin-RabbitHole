/**
 * Applies durable settings migrations at the storage boundary. The Local
 * provider originally shipped as `custom`; that alias remains supported here
 * forever without burdening every provider lookup in the running app.
 *
 * @param {Record<string, any>} input
 */
export function migrateSettings(input) {
  const value = { ...input };
  let changed = false;
  if (value.preset === "custom") {
    value.preset = "local";
    changed = true;
  }
  if (value.generation_setup?.preset === "custom") {
    value.generation_setup = { ...value.generation_setup, preset: "local" };
    changed = true;
  }
  if (value.providers && typeof value.providers === "object" && !Array.isArray(value.providers) && value.providers.custom) {
    value.providers = { ...value.providers };
    if (!value.providers.local) value.providers.local = value.providers.custom;
    delete value.providers.custom;
    changed = true;
  }
  return { value, changed };
}
