export function createReviewState() {
  return {
    generation: 0,
    reviewsUsed: 0,
    phase: "idle",
    active: null,
    last: null,
    completed: new Map(),
  };
}

export function shouldStartReview(state, { hash, explicit = false, autoReady = true }) {
  if (!hash) return { ok: false, code: "NO_HASH", reason: "没有可审核的契约版本" };
  if (state.active && state.active.hash === hash) {
    return { ok: false, code: "ALREADY_RUNNING", reason: "同一哈希已在审核中", hash };
  }
  const done = state.completed.get(hash);
  if (done) {
    return {
      ok: false,
      code: done.passed ? "ALREADY_PASSED" : "ALREADY_FINISHED",
      reason: done.passed ? "该版本已通过审核" : "该版本已完成审核",
      hash,
      done,
    };
  }
  if (!explicit && !autoReady) {
    return { ok: false, code: "AUTO_DISABLED", reason: "自动审核未就绪" };
  }
  if (state.phase === "exhausted" && state.last?.hash === hash) {
    return { ok: false, code: "EXHAUSTED", reason: "已用尽审核次数", hash };
  }
  if (state.phase === "passed" && state.last?.hash === hash) {
    return { ok: false, code: "ALREADY_PASSED", reason: "该版本已通过审核", hash };
  }
  return { ok: true, hash };
}

export function beginReview(state, { hash, reviewer, maxRevisions, provider }) {
  const cancelled = state.active
    ? { hash: state.active.hash, generation: state.active.generation }
    : null;
  if (state.phase === "passed" || state.phase === "exhausted") {
    state.reviewsUsed = 0;
  }
  state.generation += 1;
  state.reviewsUsed += 1;
  state.phase = "reviewing";
  state.active = {
    hash,
    generation: state.generation,
    round: state.reviewsUsed,
    maxRevisions,
    reviewer,
    provider,
  };
  state.last = {
    status: "reviewing",
    hash,
    hashShort: hash.slice(0, 8),
    round: state.reviewsUsed,
    maxRevisions,
    reviewer,
    provider,
    reason: null,
  };
  return { active: state.active, cancelled };
}

export function completeReview(state, { hash, generation, result }) {
  if (!state.active || state.active.hash !== hash || state.active.generation !== generation) {
    return { kind: "stale", hash, generation };
  }
  const round = state.active.round;
  const maxRevisions = state.active.maxRevisions;
  const reviewer = state.active.reviewer;
  const provider = state.active.provider;
  state.active = null;
  if (result.failed) {
    state.phase = "failed";
    state.last = {
      status: "failed",
      hash,
      hashShort: hash.slice(0, 8),
      round,
      maxRevisions,
      reviewer,
      provider,
      reason: result.reason,
      passed: false,
    };
    return { kind: "failed", last: state.last };
  }
  if (result.passed) {
    state.phase = "passed";
    state.completed.set(hash, { passed: true, round });
    state.last = {
      status: "passed",
      hash,
      hashShort: hash.slice(0, 8),
      round,
      maxRevisions,
      reviewer,
      provider,
      reason: null,
      passed: true,
      issues: result.issues ?? [],
      suggestions: result.suggestions ?? [],
      pathsRead: result.pathsRead ?? [],
    };
    return { kind: "passed", last: state.last };
  }
  const exhausted = round >= maxRevisions;
  state.completed.set(hash, { passed: false, round, exhausted });
  state.phase = exhausted ? "exhausted" : "needs-revision";
  state.last = {
    status: exhausted ? "exhausted" : "needs-revision",
    hash,
    hashShort: hash.slice(0, 8),
    round,
    maxRevisions,
    reviewer,
    provider,
    reason: null,
    passed: false,
    issues: result.issues ?? [],
    suggestions: result.suggestions ?? [],
    pathsRead: result.pathsRead ?? [],
  };
  return { kind: exhausted ? "exhausted" : "needs-revision", last: state.last };
}

export function failVisible(state, { reason, hash, reviewer, provider, disableAuto = false, code }) {
  const round = state.active?.round ?? state.reviewsUsed;
  const maxRevisions = state.active?.maxRevisions ?? null;
  if (state.active && (!hash || state.active.hash === hash)) state.active = null;
  state.phase = "failed";
  state.last = {
    status: "failed",
    hash: hash ?? state.last?.hash ?? null,
    hashShort: (hash ?? state.last?.hash ?? "").slice(0, 8) || null,
    round,
    maxRevisions,
    reviewer: reviewer ?? state.last?.reviewer ?? null,
    provider: provider ?? state.last?.provider ?? null,
    reason,
    code,
    disableAuto,
    passed: false,
  };
  return state.last;
}
