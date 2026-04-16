# StoryRoute — Project Notes

## Versioning rule (always apply)

Whenever you make a user-visible or deployable change, **bump the version number in every place it appears**. Do this as part of the same commit as the change.

Known version locations (keep in sync):

- `public/index.html` — splash badge: `<div id="splash-version">vX.Y.Z</div>`
- `public/index.html` — JS header comment: `// STORYROUTE vX.Y.Z`
- `public/sw.js` — service worker cache name: `const CACHE = 'storyroute-vX.Y.Z';` (bumping this invalidates old caches so clients pick up fresh assets)

Bumping rules:

- Bug fix / small tweak / content change → bump patch (`2.2.4` → `2.2.5`)
- New feature / UI change → bump minor (`2.2.x` → `2.3.0`)
- Breaking change or major redesign → bump major (`2.x.y` → `3.0.0`)

Before finishing any task that edits shipped code, grep for the current version string to confirm no location was missed:

```
rg -n "vX\.Y\.Z|STORYROUTE v|storyroute-v" public/
```
