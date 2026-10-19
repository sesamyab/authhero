---
"authhero": patch
---

Fix 2-cycle in `linked_to` when the primary is demoted onto one of its own secondaries. `linkUserTo` now promotes the secondary (clears its link, repoints the former primary's other secondaries) instead of throwing, which previously failed the post-login hook.
