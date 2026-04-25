# Release And Team Rules

## Versioning

- The open client publishes SemVer versions as `@tianshe/client-open@X.Y.Z`.
- Private cloud repositories must depend on an exact open version, git tag, or release tarball. Do not use floating ranges such as `^1.0.0` for production cloud releases.
- Canary builds use prerelease versions such as `1.1.0-canary.1` and must not be promoted without a passing Open CI run.

## Release Flow

1. Merge core client changes into the open repository.
2. Run Open CI: typecheck, lint, `test:open`, boundary verification, and `build:open`.
3. Publish or tag the open version.
4. Update the private repository to the exact open version.
5. Run private cloud CI before publishing the cloud edition.

## Bug Fix Rules

- Core desktop, local data, browser automation, and plugin runtime bugs are fixed in open first.
- Cloud auth, cloud snapshot, cloud catalog, private-admin integration, and private ACL bugs stay in private.
- Do not patch generated private workspaces or vendored open output directly. Change the source repo and regenerate.
