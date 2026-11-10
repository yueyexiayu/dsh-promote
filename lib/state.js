export const MAX_COMPLETED_REVIEWS = 256;

export function createReviewState() {
  return {
    generation: 0,
    reviewsUsed: 0,
    sessionReviews: 0,
    phase: "idle",
    active: null,
    last: null,
    completed: new Map(),
  };
}

function rememberCompleted(state, hash, value) {
  state.completed.delete(hash);
  state.completed.set(hash, value);
  while (state.completed.size > MAX_COMPLETED_REVIEWS) {
    state.completed.delete(state.completed.keys().next().value);
  }
}

function withCounts(state, fields) {
  return {
    ...fields,
    sessionRound: state.sessionReviews,
    versionRound: fields.round,
  };
}

export function isRecoverableConfigFailure(code) {
  return ["SETTINGS_INVALID", "UNCONFIGURED", "BOTH_MATCH_MAIN", "A_EQUALS_B", "NO_MAIN", "AUTO_DISABLED", "AUTH_UNAVAILABLE"].includes(code);
}

export function shouldStartReview(state, { hash, explicit = false, autoReady = true }) {
  if (!hash) return { ok: false, code: "NO_HASH", reason: "没有可审核的契约版本" };
  if (state.active && state.active.hash === hash) {
    return { ok: false, code: "ALREADY_RUNNING", reason: "同一哈希已在审核中", hash };
  }
  if (state.last?.hash === hash && state.last?.status === "failed" && state.last.retryable === false
    && !(explicit && isRecoverableConfigFailure(state.last.code))) {
    return { ok: false, code: "NOT_RETRYABLE", reason: state.last.reason, hash, retryable: false };
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
  state.sessionReviews += 1;
  const round = state.reviewsUsed + 1;
  state.phase = "reviewing";
  state.active = {
    hash,
    generation: state.generation,
    round,
    maxRevisions,
    reviewer,
    provider,
  };
  state.last = withCounts(state, {
    status: "reviewing",
    hash,
    hashShort: hash.slice(0, 8),
    round,
    maxRevisions,
    reviewer,
    provider,
    reason: null,
  });
  return { active: state.active, cancelled };
}

export function completeReview(state, { hash, generation, result }) {
  if (!state.active || state.active.hash !== hash || state.active.generation !== generation) {
    return { kind: "stale", hash, generation };
  }
  const round = state.active.round;
  const maxRevisions = state.active.maxRevisions;
  const reviewer = state.active.reviewer;
  const provider = result.provider ?? state.active.provider;
  state.active = null;
  if (result.failed) {
    state.phase = "failed";
    state.last = withCounts(state, {
      status: "failed",
      hash,
      hashShort: hash.slice(0, 8),
      round,
      maxRevisions,
      reviewer,
      provider,
      reason: result.reason,
      code: result.code,
      retryable: result.retryable !== false,
      passed: false,
    });
    return { kind: "failed", last: state.last };
  }
  state.reviewsUsed = round;
  if (result.passed) {
    state.phase = "passed";
    rememberCompleted(state, hash, { passed: true, round });
    state.last = withCounts(state, {
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
    });
    return { kind: "passed", last: state.last };
  }
  const exhausted = round >= maxRevisions;
  rememberCompleted(state, hash, { passed: false, round, exhausted });
  state.phase = exhausted ? "exhausted" : "needs-revision";
  state.last = withCounts(state, {
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
  });
  return { kind: exhausted ? "exhausted" : "needs-revision", last: state.last };
}

export function failVisible(state, { reason, hash, reviewer, provider, disableAuto = false, code }) {
  const round = state.active?.round ?? state.reviewsUsed;
  const maxRevisions = state.active?.maxRevisions ?? null;
  if (state.active && (!hash || state.active.hash === hash)) state.active = null;
  state.phase = "failed";
  state.last = withCounts(state, {
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
    retryable: !disableAuto,
    passed: false,
  });
  return state.last;
}
