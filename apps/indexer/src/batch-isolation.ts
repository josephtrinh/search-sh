export interface BatchSuccess<TItem, TValue> {
  item: TItem;
  value: TValue;
}

export interface BatchFailure<TItem> {
  item: TItem;
  error: unknown;
}

export interface BatchResult<TItem, TValue> {
  successes: BatchSuccess<TItem, TValue>[];
  failures: BatchFailure<TItem>[];
}

export async function runBatchWithIsolation<TItem, TValue>(
  items: readonly TItem[],
  operation: (batch: readonly TItem[]) => Promise<readonly TValue[]>,
  shouldIsolate: (error: unknown) => boolean,
): Promise<BatchResult<TItem, TValue>> {
  if (!items.length) return { successes: [], failures: [] };

  try {
    const values = await operation(items);
    if (values.length !== items.length) {
      throw new Error(`Batch response count ${values.length} did not match request count ${items.length}`);
    }
    return {
      successes: items.map((item, index) => ({ item, value: values[index]! })),
      failures: [],
    };
  } catch (error) {
    if (items.length === 1 || !shouldIsolate(error)) {
      return { successes: [], failures: items.map((item) => ({ item, error })) };
    }

    const midpoint = Math.ceil(items.length / 2);
    const [left, right] = await Promise.all([
      runBatchWithIsolation(items.slice(0, midpoint), operation, shouldIsolate),
      runBatchWithIsolation(items.slice(midpoint), operation, shouldIsolate),
    ]);
    return {
      successes: [...left.successes, ...right.successes],
      failures: [...left.failures, ...right.failures],
    };
  }
}
