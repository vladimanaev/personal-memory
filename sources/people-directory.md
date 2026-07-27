---
name: people-directory
kind: person
enabled: false
lookup:
  command: "your-directory-lookup {query}"
  # command: prints a JSON array of matches for {query} (substituted
  # shell-quoted), minimally: [{"name": "Jane Doe", "id": "jdoe",
  # "title": "Engineer", "team": "Platform"}]. Only "name" is required;
  # "id" (when present) is the identity key.
  # Point it at YOUR directory — a CSV-backed script, an ldapsearch
  # wrapper, a contacts CLI. The store never ships credentials or
  # fetches anything itself; it only runs this local command.
  # The real command belongs in the private override
  # (memory/sources/people-directory.md), not here — enable it there too.
  # refresh: "your-directory-sync"   # optional: refresh a local cache
  # cache_ttl_days: 14               # optional: how stale that cache may get
---

# Resolving people against the directory

Consult this source before minting a NEW person slug — run the lookup with
the person's full name:

- **Exactly one match** → mint the slug from the canonical directory name
  (lower-kebab), and tag the entry `slug-minted-from-directory` so a wrong
  mint stays findable.
- **Zero or multiple matches** → do not mint; keep the person's name in the
  entry body only, or reuse an existing slug if one clearly fits.

Maintenance uses the same lookup to check slug-merge suggestions: two slugs
resolving to distinct directory identities auto-dismiss the suggestion; both
resolving to the same identity raises its confidence.

Never let a lookup gate a capture: if the command is unavailable or slow,
write the memory anyway and sort the slug out later.
