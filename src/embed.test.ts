import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_EMBED_BATCH, embedBatchSize, embedInBatches, type Embedder } from "./embed.js";

/** Deterministic fake: each vector encodes its text, and every call's size is recorded. */
function fakeEmbedder(): Embedder & { calls: number[] } {
  const calls: number[] = [];
  return {
    id: "fake",
    dim: 2,
    calls,
    async embed(texts: string[]) {
      calls.push(texts.length);
      return texts.map((t) => [Number(t.slice(1)), t.length]);
    },
  };
}

const texts = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);

test("N texts → ceil(N/B) calls, none larger than B, order preserved", async () => {
  const fake = fakeEmbedder();
  const vectors = await embedInBatches(fake, texts(10), 4);
  assert.deepEqual(fake.calls, [4, 4, 2]);
  assert.deepEqual(
    vectors.map((v) => v[0]),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
});

test("an exact multiple of B makes no trailing empty call", async () => {
  const fake = fakeEmbedder();
  await embedInBatches(fake, texts(6), 3);
  assert.deepEqual(fake.calls, [3, 3]);
});

test("B larger than N → one call", async () => {
  const fake = fakeEmbedder();
  const vectors = await embedInBatches(fake, texts(5), 64);
  assert.deepEqual(fake.calls, [5]);
  assert.equal(vectors.length, 5);
});

test("empty input → zero calls", async () => {
  const fake = fakeEmbedder();
  assert.deepEqual(await embedInBatches(fake, [], 4), []);
  assert.deepEqual(fake.calls, []);
});

test("batched output equals one unbatched call", async () => {
  const input = texts(23);
  const batched = await embedInBatches(fakeEmbedder(), input, 5);
  const whole = await fakeEmbedder().embed(input);
  assert.deepEqual(batched, whole);
});

test("a non-positive or fractional batch size is rejected before any call", async () => {
  for (const bad of [0, -1, 2.5, Number.NaN]) {
    const fake = fakeEmbedder();
    await assert.rejects(embedInBatches(fake, texts(3), bad), RangeError);
    assert.deepEqual(fake.calls, []);
  }
});

test("MEMORY_EMBED_BATCH: positive integers are used, anything else falls back", () => {
  assert.equal(DEFAULT_EMBED_BATCH, 16);
  assert.equal(embedBatchSize("48"), 48);
  assert.equal(embedBatchSize(" 32 "), 32);
  for (const bad of [undefined, "", "   ", "0", "-8", "2.5", "abc", "Infinity"]) {
    assert.equal(embedBatchSize(bad), DEFAULT_EMBED_BATCH, `input ${JSON.stringify(bad)}`);
  }
});

test("the default batch size comes from MEMORY_EMBED_BATCH", async () => {
  const prev = process.env.MEMORY_EMBED_BATCH;
  process.env.MEMORY_EMBED_BATCH = "3";
  try {
    const fake = fakeEmbedder();
    await embedInBatches(fake, texts(7));
    assert.deepEqual(fake.calls, [3, 3, 1]);
  } finally {
    if (prev === undefined) delete process.env.MEMORY_EMBED_BATCH;
    else process.env.MEMORY_EMBED_BATCH = prev;
  }
});
