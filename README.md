# OUT OF DATE
# Apollo Engine
This package loads the Apollo Engine proxy in front of your GraphQL server.

# Usage
```js
const engine = require('apollo-engine');
// start from config file
engine.start('path/to/config.json');
// start from JS config object
engine.start({ ... });
// shutdown the engine process
engine.stop();
```

# Minimum configuration
This is the minimum necessary information to enable sending tracing and telemetry information.

The *origin* describes the GraphQL server that should be proxied. This server should send GraphQL tracing information on the wire with every response. If you are using Apollo Server use the `apollo-server-<variant>@tracing` package and enable the `tracing: true` configuration option.

In general, if multiple origins are supplied in configuration, the *last new origin* (bottom-most in the list) will become the only origin in use. See below about hot configuration changes for details.

```json
{
  "reporting": {
    "apiKey": "service:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  },
  "origins": [
    {
      "url": "http://localhost:8080/graphql"
    }
  ],
  "frontends": [
    {
      "host": "0.0.0.0",
      "port": 80,
      "endpoint": "/graphql"
    }
  ]
}
```

# Full Configuration
The following is an exhaustive configuration showing all the available keys and their default values
```json
{
  "logcfg": {
    "level": "debug"
  },
  "reporting": {
    "apiKey": "service:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "endpointUrl": "https://optics-staging-report.apollodata.com"
  },
  "origins": [
    {
      "url": "http://localhost:8080/graphql",
      "requestTimeout": "30s",
      "maxConcurrentRequests": 9999,
      "requestType": "JSON",
      "originType": "HTTP"
    }
  ],
  "frontends": [
    {
      "host": "0.0.0.0",
      "port": 7080,
      "endpoint": "/graphql"
    }
  ],
  "stores": [
    {
      "name": "standardCache",
      "epoch": 1,
      "timeout": "1s",
      "memcaches": [
        {
          "url": "localhost:11211"
        }
      ]
    }
  ],
  "operations": [
    {
      "signature": "{hero{name}}",
      "caches": [
        {
          "perSession": false,
          "ttl": 600,
          "store": "standardCache"
        }
      ]
    }
  ],
  "sessionAuth": {
    "store": "standardCache",
    "header": "X-AUTH-TOKEN",
    "tokenAuthUrl": "http://session-server.com/auth-path"
  }
}
```

# Configuring auth sessions
In order to ascertain a user's eligibility to access their session cache, an endpoint on the origin server needs to be able to respond to that effect. 

- `config.sessionAuth`
  - `.header` describes the header that should contain the session token
  - `.tokenAuthUrl` describes the endpoint name on the origin server which should receive the token in the POST body and respond with:
    - `200 OK` and JSON body `{ "ttl": 3000 }` when the token is valid
    - `403 Forbidden` and if not


# Hot configuration changes
If the configuration is provided as a filename, that file will be watched for changes. Changes will cause the proxy to adopt the new configuration without downtime.

For example, in order to change origins on the fly, starting with a configuration:
```json
{
  "origins": [
    {
      "url": "origin A"
    }
  ]
}
```
we may overwrite the configuration file at runtime with:
```json
{
  "origins": [
    {
      "url": "origin A"
    },
    {
      "url": "origin B"
    }
  ]
}
```
This will cause the proxy to start sending all new requests to `origin B` while finishing/draining those currently in-flight to `origin A`.

In a little while, we can overwrite the file again with
```json
{
  "origins": [
    {
      "url": "origin B"
    }
  ]
}
```
