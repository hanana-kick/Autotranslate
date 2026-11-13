// The decode engine: several sequences share one forward pass per step.
//
// Measured on the shipped graph (test-results/browser/engine-spike.json): a
// decode step costs 51.2 ms for one row and 53.3 / 54.6 / 67.3 ms for two, four
// and eight rows. Two independent sessions cost 1.68x and buy nothing, so the
// shape that wins is one session, several sequences, one step each.
//
// This file is the scheduling half and nothing else: it decides which rows go
// into the next forward, how prompts of different lengths are padded, which row
// retired, and what each request receives. Tensors, the session and the KV cache
// belong to the caller (`src/hostworker.ts`), which keeps this module testable
// without a GPU.
//
// Load after lib/constants.js.
namespace AT.engine {
  /** The logits of one step: `[rows, positions, vocab]`, last position used. */
  export type Logits = { dims: number[]; data: ArrayLike<number> };

  /** One request in flight: what it asked for and what it has so far. */
  export type Job = {
    id: number;
    /** Prompt token ids, already rendered and tokenized. */
    prompt: number[];
    /** How many tokens this request may generate, at most. */
    maxNewTokens: number;
    generated: number[];
    /** The caller gave up on it: its rows keep the batch shape and its answer
     *  is discarded, but it no longer holds the cohort open. */
    abandoned: boolean;
    /** Its answer already left, so a cohort never answers it twice. */
    delivered: boolean;
  };

  /** What a request gets back. A null token list is a failure for that id only. */
  export type Outcome =
    | { id: number; ok: true; tokens: number[] }
    | { id: number; ok: false; error: string };

  /** One forward: rows of prompt (first) or one token each (steps after). */
  export type Forward = (
    rows: { inputIds: number[][]; mask?: number[][] },
    first: boolean
  ) => Promise<{ logits: Logits }>;

  export type Options = {
    forward: Forward;
    /** Ids that end a sequence (the card's eos plus its end-of-turn token). */
    eos: number[];
    /** Rows one step may carry. */
    batch: number;
    /** Prompt tokens one prefill may carry, all rows together. The graph
     *  returns logits for every position (`[rows, width, vocab]`, float32), so
     *  four 1024-token rows would ask for ~1.7 GB in one tensor; this is the
     *  bound that keeps a long prompt from asking for it. Decode steps are one
     *  position wide and are not affected. */
    promptBudget?: number;
    /** Left-padding id, used to line prompts of different lengths up. */
    pad: number;
    /** Wait this long for siblings before a cohort starts, so a page's packs
     *  that arrive together share the first step instead of queueing. */
    coalesceMs?: number;
    onDone: (outcome: Outcome) => void;
    onError?: (error: unknown) => void;
  };

  export type Runner = {
    /** Queues a request and starts the loop if it is not running. */
    add: (job: { id: number; prompt: number[]; maxNewTokens: number }) => void;
    /** Resolves when every queued request has been answered. */
    drain: () => Promise<void>;
    /** Requests waiting for a cohort. */
    waiting: () => number;
    /** Stops spending steps on a request the caller no longer waits for. */
    drop: (id: number) => void;
  };

  /** Left-pad rows to one width, with a mask that marks the real tokens. This
   *  is what lets 17-token and 29-token prompts share a prefill; each row then
   *  decodes exactly what it decodes alone (verified in the spike). */
  export function leftPad(rows: number[][], pad: number): { inputIds: number[][]; mask: number[][] } {
    const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
    const inputIds = rows.map((row) => [...new Array<number>(width - row.length).fill(pad), ...row]);
    const mask = rows.map((row) => [...new Array<number>(width - row.length).fill(0), ...new Array<number>(row.length).fill(1)]);
    return { inputIds, mask };
  }

  /** The highest-scoring id at the last position of every row. Greedy by
   *  design: `do_sample: false` was the only mode this host ever used. */
  export function argmaxLast(logits: Logits, rows: number): number[] {
    const dims = logits.dims;
    const positions = dims[dims.length - 2] ?? 0;
    const vocab = dims[dims.length - 1] ?? 0;
    const data = logits.data;
    const picks = new Array<number>(rows).fill(0);
    for (let row = 0; row < rows; row += 1) {
      const base = (row * positions + (positions - 1)) * vocab;
      let best = -Infinity;
      let pick = 0;
      for (let token = 0; token < vocab; token += 1) {
        const value = Number(data[base + token]);
        if (value > best) {
          best = value;
          pick = token;
        }
      }
      picks[row] = pick;
    }
    return picks;
  }

  export function create(options: Options): Runner {
    const { forward, eos, batch, pad, coalesceMs = 0, promptBudget = Infinity, onDone, onError } = options;
    const ends = new Set(eos);
    const queue: Job[] = [];
    const cap = Math.max(1, Math.floor(batch));
    let loop: Promise<void> | null = null;
    /** The cohort being decoded right now, so `drop` can reach its rows. */
    let active: Job[] = [];

    const done = (job: Job): boolean =>
      job.abandoned || job.generated.length >= job.maxNewTokens || ends.has(job.generated[job.generated.length - 1] ?? -1);

    function answer(outcome: Outcome): void {
      try {
        onDone(outcome);
      } catch (error: unknown) {
        onError?.(error);
      }
    }

    /** One cohort: prefill together, then one step per token until every row is
     *  done. A row that finished early costs its own marginal row time for the
     *  rest of the cohort (≈2 ms at batch 8) and nothing else. */
    async function runCohort(cohort: Job[]): Promise<void> {
      const padded = leftPad(cohort.map((job) => job.prompt), pad);
      // The mask has to span everything the cache holds: the padded prompt and
      // one entry per generated token, or the graph attends to the new token
      // alone and the answer is nonsense.
      const masks = padded.mask.map((row) => [...row]);
      let picks: number[];
      try {
        const first = await forward({ inputIds: padded.inputIds, mask: masks.map((row) => [...row]) }, true);
        picks = argmaxLast(first.logits, cohort.length);
      } catch (error: unknown) {
        const message = String((error as { message?: unknown })?.message ?? error);
        for (const job of cohort) {
          if (job.delivered || job.abandoned) continue;
          job.delivered = true;
          answer({ id: job.id, ok: false, error: message });
        }
        return;
      }
      cohort.forEach((job, row) => job.generated.push(picks[row] ?? 0));
      deliver(cohort);
      while (cohort.some((job) => !done(job))) {
        // Every row feeds its newest token, finished ones included: the batch
        // shape stays fixed, so the cache never has to be sliced.
        const rows = cohort.map((job) => [job.generated[job.generated.length - 1] ?? pad]);
        for (const mask of masks) mask.push(1);
        try {
          const step = await forward({ inputIds: rows, mask: masks.map((row) => [...row]) }, false);
          picks = argmaxLast(step.logits, rows.length);
        } catch (error: unknown) {
          const message = String((error as { message?: unknown })?.message ?? error);
          for (const job of cohort) {
            if (job.delivered || job.abandoned) continue;
            job.delivered = true;
            answer({ id: job.id, ok: false, error: message });
          }
          return;
        }
        for (let row = 0; row < cohort.length; row += 1) {
          const job = cohort[row]!;
          if (done(job)) continue;
          job.generated.push(picks[row] ?? 0);
        }
        // A row that reached its end token does not wait for the cohort's
        // slowest row: the page gets its text as soon as it exists.
        deliver(cohort);
      }
    }

    /** Hands over every row that is done and has not been answered yet. */
    function deliver(cohort: Job[]): void {
      for (const job of cohort) {
        if (job.delivered || job.abandoned || !done(job)) continue;
        job.delivered = true;
        answer({ id: job.id, ok: true, tokens: job.generated });
      }
    }

    async function pump(): Promise<void> {
      while (queue.length) {
        // Always one task of quiet, even at coalesceMs 0: a page's packs arrive
        // in the same tick, and a cohort taken synchronously would split them
        // into solo prefills — exactly the cost this engine exists to avoid.
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, coalesceMs)));
        const cohort = queue.splice(0, take());
        active = cohort;
        try {
          await runCohort(cohort);
        } finally {
          active = [];
        }
      }
    }

    /** How many of the queued requests this prefill can carry: the widest
     *  prompt decides the logits the batch asks for, and the first request in
     *  line sets the width for the cohort behind it. */
    function take(): number {
      const head = queue[0];
      if (!head) return 0;
      const byTokens = Math.floor(promptBudget / Math.max(1, head.prompt.length));
      return Math.max(1, Math.min(cap, byTokens, queue.length));
    }

    function start(): void {
      if (loop) return;
      loop = pump().finally(() => {
        loop = null;
        // A request added while the last cohort was finishing starts a new run.
        if (queue.length) start();
      });
    }

    return {
      add(job) {
        queue.push({
          id: job.id,
          prompt: [...job.prompt],
          maxNewTokens: Math.max(1, Math.floor(job.maxNewTokens)),
          generated: [],
          abandoned: false,
          delivered: false
        });
        start();
      },
      async drain() {
        while (loop) await loop;
      },
      waiting: () => queue.length,
      drop(id) {
        const queued = queue.findIndex((job) => job.id === id);
        if (queued >= 0) {
          queue.splice(queued, 1);
          return;
        }
        // In a cohort: it keeps its row (the cache shape cannot shrink) and its
        // answer is thrown away, but the step no longer waits for it.
        for (const job of active) if (job.id === id) job.abandoned = true;
      }
    };
  }
}
