# apollo-engine-js release notes

This file describes changes to the apollo-engine npm module. This module is a
wrapper around the Engine Proxy binary, which is also available as a Docker
container.

This file explicitly describes changes made directly to the npm module
itself. Many of the more interesting changes are updates to the Engine Proxy,
which has its own detailed [Release
Notes](https://www.apollographql.com/docs/engine/proxy-release-notes.html) in
the Engine documenation.

### vNext (probably 0.9.0)
- Upgrade Engine Proxy to
  [`2018.02-90-g65206681c`](https://www.apollographql.com/docs/engine/proxy-release-notes.html#v2018.02-90-g65206681c),
  including changes in `2018.02-84-g7a295e631` and `2018.02-50-gef2fc6d4e`.
- Simplify how the apollo-engine npm module communicates with the Engine Proxy
  binary.  **Backwards-incompatible changes**:
  + The `logger` option to `new Engine` added in 0.8.9 no longer exists. It is
    replaced by `proxyStdoutStream` and `proxyStderrStream` options, as well as
    a `restarting` event on the `Engine` object.
  + The default log style is now the same as in the Docker container release of
    engineproxy: textual logs over stdout, instead of JSON over stderr.
- `new Engine` now throws if given unknown top-level options.

### 0.8.10 - 2018-02-12
- Upgrade Engine Proxy to
  [`2018.02-37-g678cbb68b`](https://www.apollographql.com/docs/engine/proxy-release-notes.html#v2018.02-37-g678cbb68b).

### 0.8.9 - 2018-02-06

- Upgrade Engine Proxy to
  [`2018.02-2-g0b77ff3e3`](https://www.apollographql.com/docs/engine/proxy-release-notes.html#v2018.02-2-g0b77ff3e3).
- Properly forward the Host header to the Engine Proxy.
- New `logger` option to override some aspects of logging in
  apollo-engine. (Removed in 0.9.0.)
- Do not override http origin url if set.
- Allow endpoint to end with '/' or '\'

