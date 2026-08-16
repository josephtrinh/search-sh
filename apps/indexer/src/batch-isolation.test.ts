import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runBatchWithIsolation } from "./batch-isolation";

class InputError extends Error {}
const isInputError = (error: unknown) => error instanceof InputError;

describe("runBatchWithIsolation", () => {
  it("keeps a successful batch intact", async () => {
    let calls = 0;
    const result = await runBatchWithIsolation([1, 2, 3], async (items) => {
      calls++;
      return items.map((item) => item * 10);
    }, isInputError);

    assert.equal(calls, 1);
    assert.deepEqual(result.successes, [
      { item: 1, value: 10 },
      { item: 2, value: 20 },
      { item: 3, value: 30 },
    ]);
    assert.deepEqual(result.failures, []);
  });

  it("isolates a single invalid input after a batch 422", async () => {
    const calls: number[][] = [];
    const result = await runBatchWithIsolation([1, 2, 3, 4, 5, 6, 7, 8], async (items) => {
      calls.push([...items]);
      if (items.includes(5)) throw new InputError("unsupported image");
      return items.map((item) => item * 10);
    }, isInputError);

    assert.deepEqual(result.successes.map(({ item }) => item), [1, 2, 3, 4, 6, 7, 8]);
    assert.deepEqual(result.failures.map(({ item }) => item), [5]);
    assert.ok(calls.some((items) => items.length === 1 && items[0] === 5));
  });

  it("does not split a batch for a non-input server failure", async () => {
    let calls = 0;
    const result = await runBatchWithIsolation([1, 2, 3], async () => {
      calls++;
      throw new Error("model unavailable");
    }, isInputError);

    assert.equal(calls, 1);
    assert.deepEqual(result.successes, []);
    assert.deepEqual(result.failures.map(({ item }) => item), [1, 2, 3]);
  });

  it("does not isolate a malformed success response", async () => {
    let calls = 0;
    const result = await runBatchWithIsolation([1, 2], async () => {
      calls++;
      return [10];
    }, isInputError);

    assert.equal(calls, 1);
    assert.deepEqual(result.failures.map(({ item }) => item), [1, 2]);
  });
});
