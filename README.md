# Autorelease Tagger

### Generates new version tags from git history

The process, in detail:

 - Use `git describe` to figure out the nearest ancestor version tag (`v*`) of the current commit
 - If that tag is pointing to this commit, do nothing
 - Otherwise, figure out the next version by looking at the _first line_ of all commits between the last version and the current commit:
   - figure out the bump strategy:
     - extract any instances of `[(major|minor|patch)(-release)?]` (i.e. `[major]`, `[minor]`, `[patch]`, `[major-release]`, etc)
     - use the highest one found
     - if no explicit bump is found, use` defaultBump` (defaults to `minor`)
   - if the bump strategy is greater than `maxBump` (default unset), fail (this can be used to ensure a version branch only makes patch releases)
   - if the bump strategy is greater than `minBump` (default unset), use `minBump` instead (conversely used to ensure all new `master` commits create minor versions instead of patch releases)
   - apply the bump to make a new version:
     - if `releaseTrigger` is `auto`, a new release is always made
     - if `releaseTrigger` is `commit`, a new release is only made if the commit message contains `[release]` (or `[major-release]`, `[minor-release]`, `[patch-release]`)
 - tag it (if `doTag`, default `true`)
 - push it (if `doPush`, default `true` except for Pull Requests)

# Big thanks

Inpired by the [Github Tag Bump](https://github.com/marketplace/actions/github-tag-bump) action, but with a few improvements:
 - use `git describe`
 - implement in JS (well, it's better than bash), with tests
 - minBump / maxBump
 - not hardcoded to 3 release components
 - stricter bump detection (matches whole words, not just substring)
 - still does validation and tagging on PR branches (`doPush` defaults to false for PRs)
