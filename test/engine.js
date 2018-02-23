const http = require('http');
const express = require('express');
const {graphqlExpress} = require('apollo-server-express');
const bodyParser = require('body-parser');
const {createServer} = require('net');
const {Writable} = require('stream');

const {assert} = require('chai');
const isRunning = require('is-running');

const {Engine} = require('../lib/index');

const {schema, rootValue, verifyEndpointSuccess} = require('./schema');
const {testEngine} = require('./test');

describe('engine', () => {
  let app, engine = null;
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

  function gqlServer(path) {
    path = path || '/graphql';
    app.get(`${path}/ping`, (req, res) => {
      res.json({'pong': true});
    });

    app.use(path, bodyParser.json(), graphqlExpress({
      schema: schema,
      rootValue: rootValue,
      tracing: true
    }));

    return http.createServer(app).listen().address().port;
  }

  function setupEngine(path) {
    engine = testEngine(path);
    app.use(engine.expressMiddleware());

    engine.graphqlPort = gqlServer(path);
  }

  describe('config', () => {
    it('allows reading from file proxy', async () => {
      // Install middleware before GraphQL handler:
      engine = new Engine({
        endpoint: '/graphql',
        engineConfig: 'test/engine.json',
        graphqlPort: 1
      });
      app.use(engine.expressMiddleware());

      let port = gqlServer('/graphql');
      engine.graphqlPort = port;

      await engine.start();
      return verifyEndpointSuccess(`http://localhost:${port}/graphql`, false);
    });

    it('appends configuration', (done) => {
      // Grab a random port locally:
      const srv = createServer();
      srv.on('listening', async () => {
        const extraPort = srv.address().port;
        srv.close();

        // Setup engine, with an extra frontend on that port:
        let engineConfig = {
          frontends: [{
            host: '127.0.0.1',
            endpoint: '/graphql',
            port: extraPort
          }],
          reporting: {
            disabled: true,
            noTraceVariables: true
          }
        };
        engine = new Engine({
          endpoint: '/graphql',
          engineConfig,
          graphqlPort: 1
        });
        app.use(engine.expressMiddleware());

        let port = gqlServer('/graphql');
        // Provide origins _before_ starting:
        engineConfig.origins = [
          {
            name: 'lambda',
            lambda: {
              functionArn: 'arn:aws:lambda:us-east-1:1234567890:function:mock_function',
              awsAccessKeyId: 'foo',
              awsSecretAccessKey: 'bar'
            }
          },
          {
            http: {
              url: `http://localhost:${port}/graphql`
            }
          }
        ];
        await engine.start();

        // Non-HTTP origin unchanged:
        assert.strictEqual(undefined, engineConfig.origins[0].http);
        // HTTP origin has PSK injected:
        assert.notEqual(undefined, engineConfig.origins[1].http.headerSecret);

        await verifyEndpointSuccess(`http://localhost:${port}/graphql`, false);
        await verifyEndpointSuccess(`http://localhost:${extraPort}/graphql`, false);
        done();
      }).listen(0);
    });

    it('can be configured in single proxy mode', async () => {
      // When using singleProxy the middleware is not required
      let port = gqlServer('/graphql');

      engine = new Engine({
        engineConfig: 'test/engine.json',
        graphqlPort: port,
        frontend: {
          host: '127.0.0.1',
          port: 3000,
        }
      });

      await engine.start();
      await verifyEndpointSuccess('http://localhost:3000/graphql', false);
    });


    it('can be configured in single proxy mode to use multiple endpoints', async () => {
      let testPort = gqlServer('/test/graphql');
      let defaultPort = gqlServer('/graphql');
      engine = new Engine({
        allowFullConfiguration: true,
        engineConfig: {
          apiKey: 'faked',
          origins: [
            {
              name: 'defaultOrigin',
              http: {
                url: `http://127.0.0.1:${defaultPort}/graphql`
              }
            },
            {
              name: 'testOrigin',
              http: {
                url: `http://127.0.0.1:${testPort}/graphql`
              }
            }
          ],
          frontends: [
            {
              host: '127.0.0.1',
              port: 3000,
              endpointMap: {
                '/graphql' : 'defaultOrigin',
                '/test/graphql' : 'testOrigin',
              }
            }
          ],
          reporting: {
            disabled: true,
            noTraceVariables: true
          }
        }
      });

      await engine.start()
      await verifyEndpointSuccess('http://localhost:3000/graphql', false);
      await verifyEndpointSuccess('http://localhost:3000/test/graphql', false);
    })

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
          }
        },
        engineConfig: {
          reporting: {
            disabled: true
          }
        }
      });

      await engine.start();
      // No good way to verify this propagated to the binary's config
    });

    it('accepts configuration of overridden headers', async () => {
      const overrideRequestHeaders = {
        'Host': 'example.com',
        'X-Does-Not-Exist': 'huehue',
      };
      engine = new Engine({
        graphqlPort: 1,
        origin: {
          http: {
            overrideRequestHeaders: overrideRequestHeaders
          }
        },
        engineConfig: {
          reporting: {
            disabled: true
          }
        }
      });

      assert.equal(engine.originParams.http.overrideRequestHeaders, overrideRequestHeaders);
    });

    it('does not override origin url', async () => {
      const userSpecifiedUrl = 'https://localhost:1000/graphql';
      engine = new Engine({
        graphqlPort: 1,
        origin: {
          http: {
            url: userSpecifiedUrl
          }
        },
        engineConfig: {
          reporting: {
            disabled: true
          }
        }
      });

      assert.strictEqual(userSpecifiedUrl, engine.originParams.http.url);
    });

    it('can be configured to use custom stdout', async () => {
      let written = false;
      const proxyStdoutStream = new Writable({
        write(chunk, encoding, callback) {
          written = true;
        }
      });
      engine = new Engine({
        graphqlPort: 1,
        proxyStdoutStream,
        engineConfig: {
          reporting: {
            disabled: true
          },
          logging: {
            destination: 'STDOUT',
          },
        }
      });

      await engine.start();
      assert(written);
    });

    it('can be configured to use custom stderr', async () => {
      let written = false;
      const proxyStderrStream = new Writable({
        write(chunk, encoding, callback) {
          written = true;
        }
      });
      engine = new Engine({
        graphqlPort: 1,
        proxyStderrStream,
        engineConfig: {
          reporting: {
            disabled: true
          }
        }
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
      const restartPromise = new Promise(resolve => {
        engine.once('start', resolve);
      });
      engine.child.kill('SIGKILL');
      await restartPromise;

      const restartedPid = engine.child.pid;
      assert.notEqual(childPid, restartedPid);
      assert.isFalse(isRunning(childPid));
      assert.isTrue(isRunning(restartedPid));

      assert.notEqual(childUri, engine.middlewareParams.uri);
    });

    it('is non-invasive on invalid config', async () => {
      setupEngine();
      engine.startupTimeout = 100;
      engine.config.logging.level = 'invalid';

      engine.on('error', (err) => {
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
  })
});
