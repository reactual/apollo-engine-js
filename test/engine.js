const http = require('http');
const express = require('express');
const { graphqlExpress } = require('apollo-server-express');
const bodyParser = require('body-parser');
const { createServer } = require('net');
const { Writable } = require('stream');
const { writeFileSync, unlinkSync, renameSync, readFileSync } = require('fs');
const tmp = require('tmp');
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
    path = path || '/graphql';
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
        endpoint: '/graphql',
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

    it('allows reloading config from file with useConfigPrecisely', async () => {
      // Make a temp filename for the config we're going to reload, and for a
      // log file we're going to eventually look for.
      const tmpConfig = tmp.fileSync({ discardDescriptor: true });
      const tmpLog = tmp.fileSync({ discardDescriptor: true });
      unlinkSync(tmpLog.name);

      const defaultPort = gqlServer('/graphql');

      // Write a basic config file out to disk. It does not have request logging
      // turned on.
      const config = {
        apiKey: 'faked',
        reporting: {
          disabled: true,
        },
        origins: [
          {
            http: {
              url: `http://127.0.0.1:${defaultPort}/graphql`,
            },
          },
        ],
        frontends: [
          {
            host: '127.0.0.1',
            port: 3000,
            endpoint: '/graphql',
          },
        ],
      };
      writeFileSync(tmpConfig.name, JSON.stringify(config));

      // Run Engine. Ask it to check the config file for reloads every 5ms
      // instead of the default 5s, for a faster test.
      engine = new Engine({
        endpoint: '/graphql',
        engineConfig: tmpConfig.name,
        useConfigPrecisely: true,
        graphqlPort: defaultPort,
        proxyStderrStream: hideProxyErrorStream(),
      });
      engine.extraArgs = ['-config-reload-file=5ms'];
      app.use(engine.expressMiddleware());

      // Make sure it runs properly.
      await engine.start();
      await verifyEndpointSuccess(`http://localhost:3000/graphql`, false);

      // Add request logging to the config file. Write it out (atomically!) and
      // wait twice the -config-reload-file amount of time.
      config.logging = {
        request: {
          destination: tmpLog.name,
        },
      };
      writeFileSync(tmpConfig.name + '.atomic', JSON.stringify(config));
      renameSync(tmpConfig.name + '.atomic', tmpConfig.name);
      await new Promise(resolve => setTimeout(resolve, 10));

      // Make a request, which should be logged.
      await verifyEndpointSuccess(`http://localhost:3000/graphql`, false);
      // Wait a moment and verify the request log exists.
      await new Promise(resolve => setTimeout(resolve, 10));
      readFileSync(tmpLog.name);
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
                endpoint: '/graphql',
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

    it('can be configured in single proxy mode to use multiple endpoints', async () => {
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
