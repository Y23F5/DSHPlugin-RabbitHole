/**
 * Normalizes every provider catalog into the one shape consumed by settings.
 * Unknown vision support is `null`; no provider-specific sentinel leaks out.
 *
 * @param {any} value
 * @returns {{id: string, name: string, vision: boolean | null, reasoning: {options: string[], default: string} | null, price?: {prompt: number, completion: number}}}
 */
export function modelDescriptor(value) {
  const reasoning = value?.reasoning && Array.isArray(value.reasoning.options)
    ? {
      options: value.reasoning.options.map(String),
      default: String(value.reasoning.default || value.reasoning.options[0] || ""),
    }
    : null;
  const descriptor = {
    id: String(value?.id || ""),
    name: String(value?.name || value?.id || ""),
    vision: typeof value?.vision === "boolean"
      ? value.vision
      : typeof value?.images === "boolean"
        ? value.images
        : null,
    reasoning,
  };
  if (value?.price) {
    descriptor.price = {
      prompt: Number(value.price.prompt) || 0,
      completion: Number(value.price.completion) || 0,
    };
  }
  return descriptor;
}
