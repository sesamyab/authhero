---
"authhero": patch
---

Set the session cookie both non-partitioned and partitioned instead of partitioned only, so top-level `/authorize` requests find the session in Safari configurations that don't send the partitioned cookie after a cross-site redirect (#1639). Successful login logs now carry `details.session_cookie` (what `/authorize` received and how the session lookup went) and `details.private_browsing` (from the login page's check), so a dropped session cookie can be traced.
