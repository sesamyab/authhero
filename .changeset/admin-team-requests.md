---
"@authhero/admin": minor
---

The Team page handles team changes that the server registers as requests (issue #1550): a write that is answered with `202` says the change was requested, a "Requested changes" card lists what is waiting, failed or just done (a failure with its reason), and the page looks again every few seconds while a request is waiting. Against a server that acts at once nothing changes.
