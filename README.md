# Apollo Engine

[![npm version](https://badge.fury.io/js/apollo-engine.svg)](https://badge.fury.io/js/apollo-engine)
[![Build Status](https://travis-ci.org/apollographql/apollo-engine-js.svg?branch=master)](https://travis-ci.org/apollographql/apollo-engine-js)

This package integrates the Apollo Engine Proxy with your GraphQL server.

When installed, it starts the Apollo Engine Proxy in a new process, then routes
GraphQL requests through that proxy:

![Sequence Diagram](docs/sequence-diagram.png)

Read the [Release Notes](CHANGELOG.md).

Please see our [Release Notes](https://www.apollographql.com/docs/engine/proxy-release-notes.html) in the Engine documenation.

> For feature requests, bug reports, or general questions or feedback on Apollo Engine Proxy, please use [this form](https://engine.apollographql.com/login?overlay=SupportRequestNoAccount) instead of opening an issue on this repository.

# Usage
```js
import { Engine } from 'apollo-engine';

// create new engine instance from JS config object
const engine = new Engine({ engineConfig: { ... } });

// create new engine instance from file.
const engine = new Engine({ engineConfig: 'path/to/config.json' });

await engine.start();
app.use(engine.expressMiddleware());

// ...
// other middleware / handlers
// ...
```

To shut down engine
```js
engine.stop();
```

The graphql server should have tracing enabled if available. If you are using Apollo Server (v1.1.0 or newer), enable the `tracing: true` configuration option.

# Minimum Engine Configuration

This is the minimum necessary information in the engine configuration object to enable sending tracing and telemetry information.

```json
{
  "apiKey": "service:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

# Middleware Configuration

```js
{
  "engineConfig": {
    // See the documentation section on https://www.apollographql.com/docs/engine/proto-doc.html
  },
  "endpoint": "/graphql",           // Path of GraphQL endpoint, normally /graphql.
  "graphqlPort": process.env.PORT,  // Port that the NodeJS server is running on.
  "startupTimeout": 5000,           // If >0, .start() will throw if the proxy binary does not finish
                                    // startup within the given number of milliseconds. Defaults to 5000ms.

  // Shortcuts to "origins" in EngineConfig
  "origin": {
    "requestTimeout": "5s",          // Time to wait for the Node server to respond to the Engine Proxy.
    "maxConcurrentRequests": 9999,   // The maximum number of concurrent GraphQL requests to make back
                                     // to the Node server.
    "supportsBatch": true,           // If false, GraphQL query batches will be broken up and processed
                                     // in parallel. If true, they are batch processed.
    "overrideRequestHeaders": {      // Headers to replace or add in requests to your origin. May be useful
      "Host": "127.0.0.1:8080",      // for virtually-hosted GraphQL servers.
      "X-New-Header": "xxxxxxxxx"
    }
  },

  // Shortcut to "frontends" in EngineConfig
  "frontend": {
    "extensions": {                             // Configuration for GraphQL response extensions
      "strip": ["cacheControl", "tracing"],     // Extensions to remove from responses served to clients
      "blacklist": ["tracing"],                 // Extensions to block from being served to clients, even if requested with "includeInResponse".
    }
  },

  proxyStdoutStream: stream,   // Redirect the Proxy's standard output to this Writable stream.
  proxyStderrStream: stream,   // Redirect the Proxy's standard error to this Writable stream.
  "dumpTraffic": false,             // If true, HTTP requests and responses will be dumped to stdout.
                                    // Should only be used if debugging an issue.
}
```

# Issue Tracking

Because this repo contains a wrapper around the Apollo Engine Proxy binary, feature requests and support cases for the underlying proxy will be closed. Please only open an issue in this repo if you believe there is an issue with the wrapper/middleware code or if you would like a feature represented in the wrapper itself.

For all other requests or questions, we encourage you to [use this form](https://engine.apollographql.com/login?overlay=SupportRequestNoAccount). The #engine channel in the [Apollo Slack](apollographql.com/#slack) can also be a great resource for general questions about Apollo Engine. Following these guidelines will ensure that your requests are seen and addressed as quickly as possible and also allows us to better collect and iterate on feedback.
