/**
 * Map with bounded concurrency while preserving input order.
 * @template T,R
 * @param {Iterable<T>} input
 * @param {number} limit
 * @param {(value: T, index: number) => Promise<R> | R} visit
 * @returns {Promise<R[]>}
 */
export async function mapConcurrent(input, limit, visit) {
  const values = [...input];
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Concurrency limit must be a positive integer");
  /** @type {R[]} */
  const output = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor++;
      output[index] = await visit(/** @type {T} */ (values[index]), index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return output;
}
