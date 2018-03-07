import * as http from 'http';
import * as request from 'request';
import { stub, SinonStub } from 'sinon';

import {
  schema,
  rootValue,
  verifyEndpointSuccess,
  verifyEndpointGet,
  verifyEndpointError,
  verifyEndpointFailure,
  verifyEndpointBatch,
} from './schema';
import { processIsRunning, devNull } from './util';

import { ApolloEngine } from '../engine';

const acceptableEndings = ['/', '?', '?123', '/?123'];

export function runSuite(
  before: Function,
  hasTracing: boolean,
  frameworkName: string,
) {
  let url: string;

  // micro has an unconfigurable behavior to console.error any error thrown by a
  // handler (https://github.com/zeit/micro/issues/329).  We use sinon to
  // override console.error; however, we use callThrough to ensure that by
  // default, it just calls console.error normally. The tests that throw errors
  // tell the stub to "stub out" console.error on the first call.
  let consoleErrorStub: SinonStub;

  beforeEach(async () => {
    consoleErrorStub = stub(console, 'error');
    consoleErrorStub.callThrough();

    url = await before();
  });

  afterEach(() => {
    consoleErrorStub.restore();
  });

  test('processes successful query', () => {
    return verifyEndpointSuccess(url, hasTracing);
  });
  acceptableEndings.forEach(acceptableEnding => {
    test(`using server endpoint ${acceptableEnding}`, () => {
      return verifyEndpointSuccess(url + acceptableEnding, hasTracing);
    });
  });
  test('processes successful GET query', () => {
    return verifyEndpointGet(url, hasTracing);
  });
  test('processes invalid query', () => {
    if (frameworkName === 'micro') {
      consoleErrorStub.onFirstCall().returns(undefined);
    }
    return verifyEndpointFailure(url);
  });
  test('processes query that errors', () => {
    return verifyEndpointError(url);
  });
  test('processes batched queries', () => {
    return verifyEndpointBatch(url, hasTracing);
  });
  test('returns cache information', async () => {
    const body: any = await verifyEndpointSuccess(url, hasTracing);
    expect(
      body['extensions'] && body['extensions']['cacheControl'],
    ).toBeDefined();
  });

  test('http proxying works', done => {
    const childUrl = `${url}/ping`;
    request(childUrl, (err, response, body) => {
      expect(err).toBe(null);
      expect(body).toBe('{"pong":true}');
      done();
    });
  });
}

export function runSuitesForHttpServerFramework(
  frameworkName: string,
  { createApp, serverForApp, appParameter }: any,
) {
  describe(`${frameworkName} integration`, () => {
    let httpServers: http.Server[] = [];
    let engine: ApolloEngine | null;

    beforeEach(() => {
      engine = null;
      httpServers = [];
    });
    afterEach(async () => {
      if (engine) {
        await engine.stop();
      }
      httpServers.forEach(server => server.close());
    });

    function gqlServer() {
      const app = createApp();
      const server = serverForApp(app);
      httpServers.push(server);
      return server.listen().address().port;
    }

    describe('without engine', () => {
      runSuite(
        async () => {
          return `http://localhost:${gqlServer()}/graphql`;
        },
        true,
        frameworkName,
      );
    });

    describe('with engine', () => {
      runSuite(
        async () => {
          const app = createApp();
          engine = new ApolloEngine({
            apiKey: 'faked',
            logging: {
              level: 'WARN',
              destination: 'STDERR',
            },
            reporting: {
              disabled: true,
            },
            frontends: [
              {
                extensions: {
                  strip: ['tracing'], // ... but not cache control!
                },
              },
            ],
          });
          const p = new Promise(resolve => {
            engine!.listen(
              {
                // Let engineproxy get an ephemeral port; we'll learn about it in the
                // listening callback.
                port: 0,
                [appParameter]: app,
              },
              () => {
                resolve(`${engine!.engineListeningAddress.url}/graphql`);
              },
            );
          });
          return await p;
        },
        false,
        frameworkName,
      );
    });
  });
}
