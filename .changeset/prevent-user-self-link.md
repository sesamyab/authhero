---
"authhero": patch
---

Reject self-links (`linked_to === user_id`) at the user-update boundary and in the `POST /api/v2/users/:user_id/identities` management endpoint. Previously a self-link could be written through the `users.update` fast-path (single-field `linked_to` updates skip all hooks to avoid recursion) or through the link-identities endpoint, which had no check that `link_with !== user_id`. A user pointing `linked_to` at its own id makes the row simultaneously primary and secondary, corrupting identity resolution and list/get views.
