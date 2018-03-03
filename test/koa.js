const koa = require('koa');
const koaRouter = require('koa-router');
const koaBody = require('koa-bodyparser');
const { graphqlKoa } = require('apollo-server-koa');
const request = require('request');
const { assert } = require('chai');

const {
  schema,
  rootValue,
  verifyEndpointSuccess,
  verifyEndpointFailure,
  verifyEndpointError,
  verifyEndpointGet,
} = require('./schema');
const { testEngine } = require('./test');

describe('koa middleware', () => {
  let app;

  // TODO: This should set the headers the 'Koa' way (???)
  const echoRequestHeadersMiddleware = async (ctx, next) => {
    const {req, res} = ctx;
    console.log('17 i am here', {body: ctx.body, host: ctx.headers.host });
    // console.log("echoReq " + ctx.header.host);
    const injectedHeader = ctx.set('x-echo-header', "");
    ctx.set('host', ctx.host)
    if (injectedHeader) {
      // console.log("inj header " + injectedHeader)
      const reqHeaders = req.header;
      res.header('content-type', 'application/json');
      res.header('x-echoed-request-headers', JSON.stringify(reqHeaders));
      res.send(200);
    }
    await next();
  };

  function gqlServer() {
    let graphqlHandler = graphqlKoa({
      schema,
      rootValue,
      tracing: true,
    });
    const router = new koaRouter();
    router.post('/graphql', koaBody(), graphqlHandler);
    router.get('/graphql', graphqlHandler);
    app.use(echoRequestHeadersMiddleware);
    app.use(router.routes());
    app.use(router.allowedMethods());
    return app.listen(0);
  }

  beforeEach(() => {
    app = new koa();
    // Don't print errors from middleware to stderr.
    app.silent = true;
  });

  describe('without engine', () => {
    let url;
    beforeEach(() => {
      let server = gqlServer();
      url = `http://localhost:${server.address().port}/graphql`;
    });

    it('processes successful query', () => {
      return verifyEndpointSuccess(url, true);
    });
    it('processes successful GET query', () => {
      return verifyEndpointGet(url, true);
    });
    it('processes invalid query', () => {
      return verifyEndpointFailure(url);
    });
    it('processes query that errors', () => {
      return verifyEndpointError(url);
    });
  });

  describe('with engine', () => {
    let url, engine;
    beforeEach(async () => {
      engine = testEngine();
      app.use(async (ctx, next) => {
        console.log("1 " + ctx.host);
        await next();
        console.log("2 " + ctx.host);
      });
      app.use(engine.koaMiddleware());
      app.use(async (ctx, next) => {
        console.log("3 " + ctx.host );
        await next();
        console.log("4 " + ctx.host );
      });
      let server = gqlServer();
      engine.graphqlPort = server.address().port;
      await engine.start();

      url = `http://localhost:${engine.graphqlPort}/graphql`;
    });
    afterEach(() => {
      engine.stop();
    });

    it('processes successful query', () => {
      return verifyEndpointSuccess(url, false);
    });

    it('processes successful GET query', () => {
      return verifyEndpointGet(url, false);
    });

    it('processes invalid query', () => {
      return verifyEndpointFailure(url);
    });

    it('processes query that errors', () => {
      return verifyEndpointError(url);
    });

    it('handles invalid response from engine', () => {
      // After engine has started, redirect the middleware to an invalid URL
      // This simulates engine returning an invalid response, without triggering
      // any actual bugs.
      engine.middlewareParams.uri = 'http://127.0.0.1:22';
