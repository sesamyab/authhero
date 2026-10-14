---
"authhero": minor
---

Add Auth0-compatible Management API endpoints for reading and replacing prompt partials.

Partials exported from an Auth0 tenant can be used as is: HTML, `<style>`, `<script>`, inline `on*` handlers and Liquid (including Liquid between attributes, e.g. `<option {% if x %}selected{% endif %}>`) are accepted and stored unchanged. Markup that escapes the login page or hijacks the form is rejected with a 400 that names it: `iframe`, `object`, `embed`, `base`, `meta`, `link`, `form`, SVG/MathML, non-`http(s)`/`mailto`/`tel` URLs and form-override attributes such as `formaction`. Each fragment is limited to 100,000 characters (Auth0 documents 10,000). The Auth0 prompt names `login-passwordless-sms-otp` and `login-passwordless-email-code` are accepted alongside `login-passwordless`.
