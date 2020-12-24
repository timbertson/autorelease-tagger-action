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
 - export the new version as an environment variable (if a key is provided in `exportEnv`)
 - tag it (if `doTag`, default `true`)
 - push it (if `doPush`, default `true` except for Pull Requests)

### versionTemplate:

As of 2020-12, a `versionTemplate` option is allowed, which provides a convenient way to specify `numComponents`, `minBump`, `maxBump`, as well as validating that the chosen version matches the expected pattern.

Examples include:

`v1.2.x`: allow only patch increments
`v1.x.x`: allow minor or patch increments
`v1.x.0`: allow only minor increments
`vx.x.x`: equivalent to `numComponents: 3`

The handling of `versionTemplate` is intentionally complex, to "do the right thing" for common use cases without requiring the use of unweildy workflow expressions:

 - any leading `refs/heads/` is stripped off
 - if the value does not begin with a version component (optional leading `v`, then at least one digit, then `.`), it will be ignored
 - if you supply both `versionTemplate` and `numComponents`, the max() of the two values is taken (so you can have a `v2.x` branch but still use 3 components)
 - if you supply both `versionTemplate` and `minBump`, `minBump` is ignored (typically `minBump` is used only on the main branch, to use on a version branch you will need to name it e.g. `v2.x.0`)
 - if you supply both `versionTemplate` and `maxBump`, `maxBump` is ignored (typically `maxBump` is used on a version branch to prevent collisions with the main branch)

This lets you pass in the branch name and have it work for both `master` and appropriately-named version branches, like so:

```yaml
- uses: timbertson/autorelease-tagger-action@v1
  with:
    numComponents: 3
    minBump: minor
    versionTemplate: ${{ github.base_ref || github.ref }}
```

That will use the `base_ref` (destination branch) for a pull request, and the current branch for a push event.
For the main branch it acts like a versionTemplate of `vx.x.0` thanks to the default `numComponents` and `minBump`.

# Big thanks

Inpired by the [Github Tag Bump](https://github.com/marketplace/actions/github-tag-bump) action, but with a few improvements:
 - use `git describe`
 - implement in JS (well, it's better than bash), with tests
 - minBump / maxBump
 - not hardcoded to 3 release components
 - stricter bump detection (matches whole words, not just substring)
 - still does validation and tagging on PR branches (`doPush` defaults to false for PRs)
