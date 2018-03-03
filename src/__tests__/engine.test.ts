import { graphqlExpress, graphqlConnect } from 'apollo-server-express';
import { graphqlKoa } from 'apollo-server-koa';
import { microGraphql } from 'apollo-server-micro';
import * as bodyParser from 'body-parser';
import * as connect from 'connect';
import { NextHandleFunction } from 'connect';
import * as express from 'express';
import * as http from 'http';
import * as koa from 'koa';
import * as koaBodyparser from 'koa-bodyparser';
import * as koaRouter from 'koa-router';
import { default as micro } from 'micro';
import * as microRouter from 'microrouter';
import * as qs from 'qs';
import * as request from 'request';
import { stub, SinonStub } from 'sinon';
import * as urlModule from 'url';

import {
  schema,
  rootValue,
  verifyEndpointSuccess,
  verifyEndpointGet,
  verifyEndpointError,
  verifyEndpointFailure,
  verifyEndpointBatch,
} from './schema';

import { ApolloEngine } from '../engine';

const acceptableEndings = ['/', '?', '?123', '/?123'];

function runSuite(
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

function connectQuery(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  next: Function,
) {
  const parsedUrl = urlModule.parse(req.url!);
  (req as any).query = qs.parse(parsedUrl.query);
  next();
}

const frameworks = {
  express: {
    createApp() {
      const path = '/graphql';
      const app = express();
      app.get(`${path}/ping`, (req, res) => {
        res.json({ pong: true });
      });
      app.use(
        path,
        bodyParser.json(),
        graphqlExpress({
          schema,
          rootValue,
          tracing: true,
          cacheControl: true,
        }),
      );
      return app;
    },
    serverForApp(app: any) {
      return http.createServer(app);
    },
    appParameter: 'expressApp',
  },

  connect: {
    createApp() {
      const path = '/graphql';
      const app = connect().use(connectQuery);
      app.use(
        `${path}/ping`,
        (req: http.IncomingMessage, res: http.ServerResponse) => {
          res.end(JSON.stringify({ pong: true }));
        },
      );
      app.use(path, bodyParser.json() as NextHandleFunction);
      app.use(path, graphqlConnect({
        schema,
        rootValue,
        tracing: true,
        cacheControl: true,
      }) as NextHandleFunction);
      return app;
    },
    serverForApp(app: any) {
      return http.createServer(app);
    },
    appParameter: 'connectApp',
  },

  koa: {
    createApp() {
      const app = new koa();
      const path = '/graphql';
      const graphqlHandler = graphqlKoa({
        schema,
        rootValue,
        tracing: true,
        cacheControl: true,
      });
      const router = new koaRouter();
      router.post('/graphql', koaBodyparser(), graphqlHandler);
      router.get('/graphql', graphqlHandler);
      router.get('/graphql/ping', async ctx => {
        ctx.body = JSON.stringify({ pong: true });
      });
      app.use(router.routes());
      app.use(router.allowedMethods());
      return app;
    },
    serverForApp(app: any) {
      return http.createServer(app.callback());
    },
    appParameter: 'koaApp',
  },

  micro: {
    createApp() {
      const handler = microGraphql({
        schema,
        rootValue,
        tracing: true,
        cacheControl: true,
      });

      return micro(
        microRouter.router(
          microRouter.get('/graphql/ping', () => {
            return JSON.stringify({ pong: true });
          }),
          microRouter.get('/graphql', handler),
          microRouter.get('/graphql/', handler),
          microRouter.post('/graphql', handler),
          microRouter.post('/graphql/', handler),
        ),
      );
    },
    serverForApp(app: any) {
      return app;
    },
    appParameter: 'httpServer',
  },
};

Object.keys(frameworks).forEach(frameworkName => {
  const { createApp, serverForApp, appParameter } = (frameworks as any)[
    frameworkName
  ];

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
              (engineListeningAddress: string) => {
                resolve(`http://${engineListeningAddress}/graphql`);
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
});
