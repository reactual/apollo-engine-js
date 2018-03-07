// We put the restify tests in their own file because importing restify breaks
// instances of express in the same process:
// https://github.com/restify/node-restify/issues/1540

import { graphqlRestify } from 'apollo-server-restify';
import * as restify from 'restify';

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
import { runSuite, runSuitesForHttpServerFramework } from './engine-common';

import { ApolloEngine } from '../engine';

runSuitesForHttpServerFramework('restify', {
  createApp() {
    const server = restify.createServer({ name: 'test server' });

    const graphQLOptions = {
      schema,
      rootValue,
      tracing: true,
      cacheControl: true,
    };

    server.use(restify.plugins.bodyParser());
    server.use(restify.plugins.queryParser());

    server.post('/graphql', graphqlRestify(graphQLOptions));
    server.get('/graphql', graphqlRestify(graphQLOptions));

    server.get('/graphql/ping', (req, res, next) => {
      res.send({ pong: true });
      next();
    });
    return server;
  },
  serverForApp(app: any) {
    return app.server;
  },
  appParameter: 'restifyServer',
});
