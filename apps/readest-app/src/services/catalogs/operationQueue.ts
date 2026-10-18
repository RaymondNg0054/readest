const operations = new Map<string, Promise<unknown>>();

export function withCatalogOperation<T>(targetId: string, work: () => Promise<T>): Promise<T> {
  const previous = operations.get(targetId);
  const result = previous ? previous.then(work, work) : work();
  const settled = result.finally(() => {
    if (operations.get(targetId) === settled) operations.delete(targetId);
  });
  operations.set(targetId, settled);
  return settled;
}
