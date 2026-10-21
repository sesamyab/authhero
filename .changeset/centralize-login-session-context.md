---
"authhero": patch
---

Route login session context writes through state-machine events and a shared persistence boundary. Preserve unrelated context when completing hooks and continuations, and enforce ownership with an ESLint rule.

Model password resets as a session-owned state machine for code and emailed-link requests. Require a matching, single-use credential from the active request before changing a password, and preserve link credentials across HTML and JSON submissions.
