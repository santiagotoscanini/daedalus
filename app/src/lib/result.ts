// The one way a function here says "this did not work" without throwing.
//
// Two mechanisms, and the choice between them is the whole convention:
//
//   throw — the caller has nothing useful to do about it. Bad input, a
//           missing row, a bridge that would not take the write. The error
//           boundary or the server function's 500 is the handler.
//   Result — the failure is an ANSWER: something the caller must render,
//           branch on, or hand back to whoever asked. A refusal is data, so
//           it gets a place in the type rather than a stack trace.
//
// One shared union rather than hand-declared copies, because copies drift
// (`{ok, message}`, `{present, error}`, an `{ok: boolean}` that does not
// narrow) and a reviewer should be able to answer "how does this codebase
// report failure?" once.
//
// `E` is a type parameter because a reason is not always a sentence: an HTTP
// read keeps the status it failed with (lib/http.ts `HttpFailure`), and a
// Pocket ID call keeps the status a 404 is told apart by
// (core/settings/profile.ts).
//
// Four unions deliberately do NOT use this type, because their failure branch
// carries a field the caller BRANCHES on rather than shows, and a nested
// `reason.code` would read worse than a flat one:
//
//   host/flow.ts `FlowOutcome` (every        `code`, which an MCP caller
//   defineFlow)                               branches on
//   core/settings/github-app.ts `convert`     the same `code`, for the
//                                             callback's redirect
//   core/github-app.ts `InstallationRepos`    `retryAfterMs`, a backoff
//   core/github-checks.ts `GhCall`            `failure`/`status`/`retryAfterMs`
//
// They are extensions of this shape, not alternatives to it: the same `ok`
// discriminant, a `reason` on failure in all but `GhCall` (whose `failure`
// plays that part), and `GhCall` names its payload `value`.

export type Result<T, E = string> = { ok: true; value: T } | { ok: false; reason: E }
