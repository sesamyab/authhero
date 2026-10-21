---
"authhero": minor
---

Encrypt action secrets and hook code secrets at rest in the encrypted data adapter (`actions.secrets[].value` and `hook_code.secrets`). Reads return plaintext; existing plaintext rows keep working and are encrypted the next time they are written. Adds `canDecrypt(value, ring)` to check that a key ring can decrypt a given ciphertext.
