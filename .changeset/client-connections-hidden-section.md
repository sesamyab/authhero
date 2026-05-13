---
"@authhero/react-admin": patch
---

Split the client Connections tab into two sections: "Visible on Login Screen" (with reorder controls) and "Hidden Connections". Hidden lists connections that won't render as login buttons — `email`/`sms`/`Username-Password-Authentication` strategies (rendered as forms) and HRD connections with `domain_aliases` but `show_as_button !== true` — and removes the reorder buttons that have no effect on those. The Hidden section is omitted when empty.
