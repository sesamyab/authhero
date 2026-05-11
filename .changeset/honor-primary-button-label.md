---
"authhero": patch
"@authhero/widget": patch
---

Honor `theme.colors.primary_button_label` unconditionally instead of dropping it when its WCAG contrast against `primary_button` falls below 4.5. Previously, a tenant setting (e.g.) white text on a medium blue button was silently overridden by an auto-picked black, because the contrast ratio sat just under the AA threshold. The tenant's explicit choice now wins; the auto-picker only runs when no label is set.
