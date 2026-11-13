import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.ts';

const AT = load('lib/constants.js', 'lib/engine.js');
const { engine } = AT;

/** A fake session whose top-1 pick is a scripted function of the fed token.
 *  Vocab 8, so the logits stay small enough to build per step. */
function scripted(next: (token: number, row: number, step: number) => number) {
  const calls: { first: boolean; inputIds: number[][]; mask?: number[][] | undefined }[] = [];
  const forward = async (
    rows: { inputIds: number[][]; mask?: number[][] },
    first: boolean
  ): Promise<{ logits: { dims: number[]; data: number[] } }> => {
    calls.push({ first, inputIds: rows.inputIds.map((row) => [...row]), mask: rows.mask?.map((row) => [...row]) });
    const width = rows.inputIds[0]!.length;
    const vocab = 8;
    const data = new Array<number>(rows.inputIds.length * width * vocab).fill(0);
    const picks = rows.inputIds.map((row, index) => {
      const last = row[row.length - 1] ?? 0;
      return next(last, index, calls.length);
    });
    for (let row = 0; row < rows.inputIds.length; row += 1) {
      data[(row * width + (width - 1)) * vocab + (picks[row] ?? 0)] = 10;
    }
    return { logits: { dims: [rows.inputIds.length, width, vocab], data } };
  };
  return { forward, calls };
}

async function run(options: {
  jobs: { id: number; prompt: number[]; maxNewTokens: number }[];
  batch: number;
  next?: (token: number, row: number, step: number) => number;
  eos?: number[];
  coalesceMs?: number;
  failAt?: number;
  promptBudget?: number;
}) {
  const script = scripted(options.next ?? ((token) => (token + 1) % 5));
  const outcomes: Record<string, unknown> = {};
  const order: number[] = [];
  let attempts = 0;
  const runner = engine.create({
    forward: async (rows: { inputIds: number[][]; mask?: number[][] }, first: boolean) => {
      const attempt = attempts;
      attempts += 1;
      if (options.failAt === attempt) throw new Error('session refused');
      return await script.forward(rows, first);
    },
    eos: options.eos ?? [3],
    batch: options.batch,
    pad: 0,
    coalesceMs: options.coalesceMs ?? 0,
    ...(options.promptBudget === undefined ? {} : { promptBudget: options.promptBudget }),
    onDone: (outcome: { id: number; ok: boolean; tokens?: number[] }) => {
      outcomes[outcome.id] = outcome;
      order.push(outcome.id);
    }
  });
  for (const job of options.jobs) runner.add(job);
  await runner.drain();
  return { calls: script.calls, outcomes, order };
}

test('prompts of different lengths share one padded prefill', async () => {
  const { calls, outcomes } = await run({
    jobs: [
      { id: 1, prompt: [1, 2, 3], maxNewTokens: 2 },
      { id: 2, prompt: [1, 2, 3, 4, 5], maxNewTokens: 2 }
    ],
    batch: 4,
    next: () => 7
  });
  assert.equal(calls.length, 2, 'one prefill and one step, not one run per request');
  assert.deepEqual(calls[0]!.inputIds, [[0, 0, 1, 2, 3], [1, 2, 3, 4, 5]], 'the short row is left-padded');
  assert.deepEqual(calls[0]!.mask, [[0, 0, 1, 1, 1], [1, 1, 1, 1, 1]], 'padding is masked out');
  assert.deepEqual((outcomes[1] as { tokens: number[] }).tokens, [7, 7]);
  assert.deepEqual((outcomes[2] as { tokens: number[] }).tokens, [7, 7]);
  // The step's mask must still cover the padded prompt plus the new token;
  // a one-wide mask would make the graph attend to that token alone.
  assert.deepEqual(calls[1]!.mask, [[0, 0, 1, 1, 1, 1], [1, 1, 1, 1, 1, 1]]);
});

test('the batch size caps each cohort, and the queue is served in order', async () => {
  const { calls, order } = await run({
    jobs: [1, 2, 3, 4, 5].map((id) => ({ id, prompt: [1, id], maxNewTokens: 1 })),
    batch: 2
  });
  const prefillRows = calls.filter((call) => call.first).map((call) => call.inputIds.length);
  assert.deepEqual(prefillRows, [2, 2, 1], 'five requests in cohorts of two');
  assert.deepEqual(order, [1, 2, 3, 4, 5], 'answers keep the order the requests arrived in');
});

test('a sequence that ends early leaves the batch, and only it stops', async () => {
  const { calls, outcomes } = await run({
    jobs: [
      { id: 1, prompt: [1], maxNewTokens: 6 },
      { id: 2, prompt: [1], maxNewTokens: 6 }
    ],
    batch: 2,
    eos: [3],
    // Row 0 reaches the end token immediately, row 1 never does.
    next: (_token, row) => (row === 0 ? 3 : 4)
  });
  assert.deepEqual((outcomes[1] as { tokens: number[] }).tokens, [3], 'row 0 stops at its end token');
  assert.equal((outcomes[2] as { tokens: number[] }).tokens.length, 6, 'row 1 runs to its own cap');
  const steps = calls.filter((call) => !call.first);
  assert.equal(steps.length, 5, 'the cohort runs until the slowest row is done');
  assert.deepEqual(steps.at(-1)!.inputIds.map((row) => row.length), [1, 1], 'the retired row keeps the batch shape');
});

test('max_new_tokens is honoured without an extra step', async () => {
  const { calls, outcomes } = await run({
    jobs: [{ id: 1, prompt: [1, 2], maxNewTokens: 1 }],
    batch: 2
  });
  assert.equal(calls.length, 1, 'the prefill answers the only token asked for');
  assert.deepEqual((outcomes[1] as { tokens: number[] }).tokens, [3], 'the prefill pick is the only token');
});

test('a failed forward fails that cohort only; the next one still runs', async () => {
  const { outcomes } = await run({
    jobs: [1, 2, 3].map((id) => ({ id, prompt: [1], maxNewTokens: 1 })),
    batch: 2,
    failAt: 0
  });
  assert.deepEqual(outcomes[1], { id: 1, ok: false, error: 'session refused' });
  assert.deepEqual(outcomes[2], { id: 2, ok: false, error: 'session refused' });
  assert.deepEqual((outcomes[3] as { ok: boolean }).ok, true, 'the queued request is still served');
});

test('a request added mid-cohort is admitted after it, not dropped', async () => {
  const script = scripted(() => 7);
  const outcomes: Record<string, unknown> = {};
  const runner = engine.create({
    forward: script.forward,
    eos: [],
    batch: 2,
    pad: 0,
    onDone: (outcome: { id: number; ok: boolean; tokens?: number[] }) => {
      outcomes[outcome.id] = outcome;
      if (outcome.id === 1) runner.add({ id: 9, prompt: [1], maxNewTokens: 1 });
    }
  });
  runner.add({ id: 1, prompt: [1], maxNewTokens: 1 });
  await runner.drain();
  assert.ok(outcomes[9], 'the late request was answered');
  assert.equal(script.calls.filter((call) => call.first).length, 2, 'it got its own prefill');
});

test('leftPad keeps whitespace-free rows aligned and argmaxLast reads the last position', () => {
  const padded = engine.leftPad([[5, 6], [9]], 0);
  assert.deepEqual(padded.inputIds, [[5, 6], [0, 9]]);
  assert.deepEqual(padded.mask, [[1, 1], [0, 1]]);
  // Two rows, two positions, vocab 4: row 0 peaks at the last position on 3,
  // row 1 has its peak at an earlier position that must be ignored.
  const logits = {
    dims: [2, 2, 4],
    data: [0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 1, 0, 2, 0, 0]
  };
  assert.deepEqual(engine.argmaxLast(logits, 2), [3, 1]);
});

test('a long prompt shrinks the cohort to what the prefill budget allows', async () => {
  // The graph returns every position's logits, so a prefill is bounded in
  // tokens: 300-token rows take two per cohort under a 700-token budget.
  const { calls } = await run({
    jobs: [1, 2, 3].map((id) => ({ id, prompt: new Array<number>(300).fill(1), maxNewTokens: 1 })),
    batch: 4,
    promptBudget: 700
  });
  const prefillRows = calls.filter((call) => call.first).map((call) => call.inputIds.length);
  assert.deepEqual(prefillRows, [2, 1], 'the budget, not the row cap, decides for long prompts');
});

test('a row that finishes is answered at once, not when the cohort does', async () => {
  const script = scripted((_token, row) => (row === 0 ? 3 : 4));
  const seen: { id: number; calls: number }[] = [];
  const outcomes: Record<string, unknown> = {};
  const runner = engine.create({
    forward: script.forward,
    eos: [3],
    batch: 2,
    pad: 0,
    onDone: (outcome: { id: number; ok: boolean; tokens?: number[] }) => {
      seen.push({ id: outcome.id, calls: script.calls.length });
      outcomes[outcome.id] = outcome;
    }
  });
  runner.add({ id: 1, prompt: [1], maxNewTokens: 6 });
  runner.add({ id: 2, prompt: [1], maxNewTokens: 4 });
  await runner.drain();
  const short = seen.find((entry) => entry.id === 1)!;
  const long = seen.find((entry) => entry.id === 2)!;
  assert.equal(short.calls, 1, 'the row that ended on its prefill came back immediately');
  assert.equal(long.calls, 4, 'the other row kept the cohort running');
  assert.deepEqual((outcomes[1] as { tokens: number[] }).tokens, [3]);
  assert.equal((outcomes[2] as { tokens: number[] }).tokens.length, 4);
});

test('progress contains only generated ids and a dropped row stays silent during a pending step', async () => {
  const script = scripted((_token, _row, step) => step + 1);
  const progress: number[][] = [];
  const outcomes: unknown[] = [];
  const runner = engine.create({
    forward: async (rows: { inputIds: number[][]; mask?: number[][] }, first: boolean) => {
      if (!first) runner.drop(7);
      return await script.forward(rows, first);
    },
    eos: [7], batch: 1, pad: 0,
    onDone: (outcome: unknown) => outcomes.push(outcome)
  });
  runner.add({
    id: 7, prompt: [5, 6], maxNewTokens: 4,
    onProgress: (tokens: number[]) => progress.push([...tokens])
  });
  await runner.drain();
  assert.deepEqual(progress, [[2]], 'neither prompt ids nor a pick read after cancellation is published');
  assert.deepEqual(outcomes, [], 'a cancelled generation never becomes a success');
});
