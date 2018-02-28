const http = require('http');
const express = require('express');
const { graphqlExpress } = require('apollo-server-express');
const bodyParser = require('body-parser');
const { createServer } = require('net');
const { Writable } = require('stream');

const { assert } = require('chai');
const isRunning = require('is-running');

const { Engine } = require('../lib/index');

const { schema, rootValue, verifyEndpointSuccess } = require('./schema');
const { testEngine } = require('./test');

describe('engine', () => {
  let app,
    engine = null,
    didHideProxyError,
    hideProxyErrorStream,
    hiddenProxyError;
  beforeEach(() => {
    app = express();
  });
  afterEach(async () => {
    if (engine) {
      if (engine.running) {
        const pid = engine.child.pid;
        await engine.stop();
        assert.isFalse(isRunning(pid));
      }
      engine = null;
    }
  });

  // Allow tests that run engineproxy to hide its output on success but show its
  // output on failure.
  beforeEach(() => {
    didHideProxyError = false;
    hiddenProxyError = '';
    hideProxyErrorStream = () => {
      if (didHideProxyError) {
        throw new Error('Can only call hideProxyErrorStream once per test');
      }
      didHideProxyError = true;
      return new Writable({
        write(chunk, encoding, callback) {
          hiddenProxyError += chunk.toString();
        },
      });
    };
  });
  afterEach(function() {
    // we need to access 'this', so no arrow function
    if (didHideProxyError && this.currentTest.state !== 'passed') {
      console.error('engineproxy error output:');
      console.error(hiddenProxyError);
    }
  });

  function gqlServer(path) {
    return gqlServerForMultiplePaths([path || '/graphql']);
  }

  function gqlServerForMultiplePaths(paths) {
    paths.forEach(
      path => {
        app.get(`${path}/ping`, (req, res) => {
          res.json({ pong: true });
        });

        app.use(
          path,
          bodyParser.json(),
          graphqlExpress({
            schema: schema,
            rootValue: rootValue,
            tracing: true,
          }),
        );
      }
    )

    return http
      .createServer(app)
      .listen()
      .address().port;
  }

  function setupEngine(path, options = {}) {
    engine = testEngine(path, options);
    app.use(engine.expressMiddleware());

    engine.graphqlPort = gqlServer(path);
  }

  describe('config', () => {
    it('throws on unknown top level keys', () => {
      assert.throws(
        () => new Engine({ unknownKey: true }),
        Error,
        /Unknown option 'unknownKey'/,
      );
    });
    it('allows reading config from file', async () => {
      // Install middleware before GraphQL handler:
      engine = new Engine({
        endpoints: ['/graphql'],
        engineConfig: 'test/engine.json',
        graphqlPort: 1,
        proxyStderrStream: hideProxyErrorStream(),
      });
      app.use(engine.expressMiddleware());

      let port = gqlServer('/graphql');
      engine.graphqlPort = port;

      await engine.start();
      return verifyEndpointSuccess(`http://localhost:${port}/graphql`, false);
    });

    it('appends configuration', done => {
      // Grab a random port locally:
      const srv = createServer();
      srv
        .on('listening', async () => {
          const extraPort = srv.address().port;
          srv.close();

          // Setup engine, with an extra frontend on that port:
          let engineConfig = {
            frontends: [
              {
                host: '127.0.0.1',
                endpointMap: { '/graphql': '/graphql' },
                port: extraPort,
              },
            ],
            reporting: {
              disabled: true,
              noTraceVariables: true,
            },
          };
          engine = new Engine({
            endpoint: '/graphql',
            engineConfig,
            graphqlPort: 1,
            proxyStderrStream: hideProxyErrorStream(),
          });
          app.use(engine.expressMiddleware());

          let port = gqlServer('/graphql');
          // Provide origins _before_ starting:
          engineConfig.origins = [
            {
              name: 'lambda',
              lambda: {
                functionArn:
                  'arn:aws:lambda:us-east-1:1234567890:function:mock_function',
                awsAccessKeyId: 'foo',
                awsSecretAccessKey: 'bar',
              },
            },
            {
              name: '/graphql',
              http: {
                url: `http://localhost:${port}/graphql`,
              },
            },
          ];
          await engine.start();

          // Non-HTTP origin unchanged:
          assert.strictEqual(undefined, engineConfig.origins[0].http);
          // HTTP origin has PSK injected:
          assert.notEqual(undefined, engineConfig.origins[1].http.headerSecret);

          await verifyEndpointSuccess(
            `http://localhost:${port}/graphql`,
            false,
          );
          await verifyEndpointSuccess(
            `http://localhost:${extraPort}/graphql`,
            false,
          );
          done();
        })
        .listen(0);
    });

    it('successfully routes multiple endpoints with middleware', async () => {
      const endpoints = ['/graphql', '/api/graphql', '/test/graphql'];

      engine = new Engine({
        graphqlPort: 1,
        endpoints: endpoints,
        engineConfig: {
          reporting: {
            disabled: true,
          }
        }
      });
      app.use(engine.expressMiddleware());

      let port = gqlServerForMultiplePaths(endpoints);
      engine.graphqlPort = port;

      await engine.start();
      // Unfortunately it's annoying to do a forEach here due to async / await
      for (let i; i < endpoints.length; i++) {
        await verifyEndpointSuccess(`http://localhost:${port}${endpoints[i]}`)
      }
    });

    it('can be configured in single proxy mode', async () => {
      // When using singleProxy the middleware is not required
      let port = gqlServer('/graphql');

      engine = new Engine({
        engineConfig: { apiKey: 'faked', reporting: { disabled: true } },
        graphqlPort: port,
        frontend: {
          host: '127.0.0.1',
          port: 3000,
        },
        proxyStderrStream: hideProxyErrorStream(),
      });

      await engine.start();
      await verifyEndpointSuccess('http://localhost:3000/graphql', false);
    });

    it('can be configured in single proxy mode with endpoint map', async () => {
      let testPort = gqlServer('/test/graphql');
      let defaultPort = gqlServer('/graphql');
      engine = new Engine({
        useConfigPrecisely: true,
        engineConfig: {
          apiKey: 'faked',
          origins: [
            {
              name: 'defaultOrigin',
              http: {
                url: `http://127.0.0.1:${defaultPort}/graphql`,
              },
            },
            {
              name: 'testOrigin',
              http: {
                url: `http://127.0.0.1:${testPort}/graphql`,
              },
            },
          ],
          frontends: [
            {
              host: '127.0.0.1',
              port: 3000,
              endpointMap: {
                '/graphql': 'defaultOrigin',
                '/test/graphql': 'testOrigin',
              },
            },
          ],
          reporting: {
            disabled: true,
            noTraceVariables: true,
          },
        },
        proxyStderrStream: hideProxyErrorStream(),
      });

      await engine.start();
      await verifyEndpointSuccess('http://localhost:3000/graphql', false);
      await verifyEndpointSuccess('http://localhost:3000/test/graphql', false);
    });

    it('sets default startup timeout', () => {
      engine = new Engine({
        graphqlPort: 1,
      });
      assert.strictEqual(engine.startupTimeout, 5000);
    });

    it('accepts zero startup timeout', () => {
      engine = new Engine({
        graphqlPort: 1,
        startupTimeout: 0,
      });
      assert.strictEqual(engine.startupTimeout, 0);
    });

    it('accepts origin TLS configuration', async () => {
      engine = new Engine({
        graphqlPort: 1,
        origin: {
          http: {
            disableCertificateCheck: true,
          },
        },
        engineConfig: {
          reporting: {
            disabled: true,
          },
        },
        proxyStderrStream: hideProxyErrorStream(),
      });

      await engine.start();
      // No good way to verify this propagated to the binary's config
    });

    it('accepts configuration of overridden headers', async () => {
      const overrideRequestHeaders = {
        Host: 'example.com',
        'X-Does-Not-Exist': 'huehue',
      };
      engine = new Engine({
        graphqlPort: 1,
        origin: {
          http: {
            overrideRequestHeaders: overrideRequestHeaders,
          },
        },
        engineConfig: {
          reporting: {
            disabled: true,
          },
        },
      });

      assert.equal(
        engine.originParams.http.overrideRequestHeaders,
        overrideRequestHeaders,
      );
    });

    it('does not override origin url', async () => {
      const userSpecifiedUrl = 'https://localhost:1000/graphql';
      engine = new Engine({
        graphqlPort: 1,
        origin: {
          http: {
            url: userSpecifiedUrl,
          },
        },
        engineConfig: {
          reporting: {
            disabled: true,
          },
        },
      });

      assert.strictEqual(userSpecifiedUrl, engine.originParams.http.url);
    });

    it('can be configured to use multiple endpoints with middleware', async () => {
      const endpoints = ['/graphql', '/api/graphql'];
      engine = new Engine({
        graphqlPort: 1,
        endpoints: endpoints,
        engineConfig: {
          reporting: {
            disabled: true,
          }
        }
      });

      assert.strictEqual(endpoints, engine.middlewareParams.endpoints);
    });

    it('can be configured to use custom stdout', async () => {
      let written = false;
      const proxyStdoutStream = new Writable({
        write(chunk, encoding, callback) {
          written = true;
        },
      });
      engine = new Engine({
        graphqlPort: 1,
        proxyStdoutStream,
        engineConfig: {
          reporting: {
            disabled: true,
          },
          logging: {
            destination: 'STDOUT',
          },
        },
      });

      await engine.start();
      assert(written);
    });

    it('can be configured to use custom stderr', async () => {
      let written = false;
      const proxyStderrStream = new Writable({
        write(chunk, encoding, callback) {
          written = true;
        },
      });
      engine = new Engine({
        graphqlPort: 1,
        proxyStderrStream,
        engineConfig: {
          reporting: {
            disabled: true,
          },
        },
      });

      await engine.start();
      assert(written);
    });
  });

  describe('process', () => {
    it('restarts binary', async () => {
      setupEngine();
      await engine.start();

      const url = `http://localhost:${engine.graphqlPort}/graphql`;
      await verifyEndpointSuccess(url);

      const childPid = engine.child.pid;
      const childUri = engine.middlewareParams.uri;
      assert.isTrue(isRunning(childPid));

      // Directly kill process, wait for notice another process has started:
      const restartingPromise = new Promise(resolve => {
        engine.once('restarting', resolve);
      });
      const restartPromise = new Promise(resolve => {
        engine.once('start', resolve);
      });
      engine.child.kill('SIGKILL');
      await restartPromise;
      await restartingPromise;

      const restartedPid = engine.child.pid;
      assert.notEqual(childPid, restartedPid);
      assert.isFalse(isRunning(childPid));
      assert.isTrue(isRunning(restartedPid));

      assert.notEqual(childUri, engine.middlewareParams.uri);
    });

    it('is non-invasive on invalid config', async () => {
      setupEngine('/graphql', { proxyStderrStream: hideProxyErrorStream() });
      engine.startupTimeout = 100;
      engine.config.logging.level = 'invalid';

      engine.on('error', err => {
        assert.match(err, /Engine crashed due to invalid configuration/);
      });
      try {
        await engine.start();
        assert.fail('Error not thrown');
      } catch (err) {
        assert.match(err, /timed out/);
      }
      assert.strictEqual('', engine.middlewareParams.uri);
    });
  });
});
