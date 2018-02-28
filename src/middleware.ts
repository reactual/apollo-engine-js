import {
  Request,
  Response,
  NextFunction
} from 'express';
import {
  Context
} from 'koa';
import {
  Server
} from 'hapi';
import * as request from 'request';
import {
  IncomingMessage,
  ServerResponse
} from 'http';
import {
  parse as urlParser
} from 'url';
import {
  bool
} from "joi";

export class MiddlewareParams {
  public endpoints: string[];
  public uri: string;
  public psk: string;
  public dumpTraffic: boolean;
}

export function makeMicroMiddleware(params: MiddlewareParams) {
  const endpointChecker = endpointsMatcher(params.endpoints);
  return function(fn: Function) {
    return function(req: IncomingMessage, res: ServerResponse) {
      const requestUrl = req.url || '';
      const matchingEndpoint = endpointChecker(requestUrl);
      if (!params.uri || !matchingEndpoint) return fn(req, res);
      else if (req.method !== 'GET' && req.method !== 'POST') return fn(req, res);
      else if (req.headers['x-engine-from'] === params.psk) return fn(req, res);
      else {
        req.url = removeExtraSlash(matchingEndpoint, requestUrl);
        proxyRequest(params, req, res);
      }
    }
  }
}

export function makeExpressMiddleware(params: MiddlewareParams) {
  const endpointChecker = endpointsMatcher(params.endpoints);
  return function(req: Request, res: Response, next: NextFunction) {
    const matchingEndpoint = endpointChecker(req.originalUrl);
    if (!params.uri || !matchingEndpoint) {
      next();
    } else if (req.method !== 'GET' && req.method !== 'POST') next();
    else if (req.headers['x-engine-from'] === params.psk) next();
    else {
      req.url = removeExtraSlash(matchingEndpoint, req.originalUrl);
      proxyRequest(params, req, res);
    }
  }
};


export function makeConnectMiddleware(params: MiddlewareParams) {
  const endpointChecker = endpointsMatcher(params.endpoints);
  return function(req: any, res: any, next: any) {
    const matchingEndpoint = endpointChecker(req.originalUrl);
    if (!params.uri || !matchingEndpoint) next();
    else if (req.method !== 'GET' && req.method !== 'POST') next();
    else if (req.headers['x-engine-from'] === params.psk) next();
    else {
      req.url = removeExtraSlash(matchingEndpoint, req.originalUrl);
      proxyRequest(params, req, res);
    }
  }
};


export function makeKoaMiddleware(params: MiddlewareParams) {
  const endpointChecker = endpointsMatcher(params.endpoints);
  return function(ctx: Context, next: () => Promise < any > ) {
    const matchingEndpoint = endpointChecker(ctx.path);
    if (!params.uri || !params.endpoints.includes(ctx.path)) return next();
    else if (ctx.req.headers['x-engine-from'] === params.psk) return next();
    else if (ctx.req.method !== 'GET' && ctx.req.method !== 'POST') return next();
    else return new Promise((resolve, reject) => {
      ctx.req.pipe(request(params.uri + ctx.originalUrl, (error, response, body) => {
        if (!!error || !response || !response.statusCode) {
          reject(new Error('Missing response from Engine proxy.'));
        } else {
          ctx.response.status = response.statusCode;
          ctx.response.set(JSON.parse(JSON.stringify(response.headers)));
          ctx.response.body = body;
          resolve();
        }
      }));
    });
  }
}

export function instrumentHapi(server: Server, params: MiddlewareParams) {
  server.ext('onRequest', (req, reply) => {
    if (!params.uri) return reply.continue();
    const path = req.url.pathname;
    if (!path || !params.endpoints.includes(path)) return reply.continue();
    else if (req.method !== 'get' && req.method !== 'post') return reply.continue();
    else if (req.headers['x-engine-from'] === params.psk) return reply.continue();
    else proxyRequest(params, req.raw.req, req.raw.res);
  });
}

function proxyRequest(
  params: MiddlewareParams,
  req: IncomingMessage,
  res: ServerResponse,
) {
  if (params.dumpTraffic) {
    req.pipe(process.stdout);
  }

  const proxyRes = req
    .pipe(
      request({
        uri: params.uri + req.url,
        forever: true,
        headers: {
          host: req.headers['host']
        },
      }),
    )
    .on('error', err => {
      console.error(err);
      res.writeHead(503);
      res.end();
    });

  if (params.dumpTraffic) {
    proxyRes.pipe(process.stdout);
  }
  proxyRes.pipe(res);
}

// Returns a function that checks if an endpoint matches the regex for multiple allowed endpoints in a list
// If the input to the returned function matches an endpoint, the matched endpoint is returned, otherwise ""
function endpointsMatcher(endpoints: string[]): (endpointToCheck: string) => string {
  return (endpointToCheck) => {
    let matchedEndpoint = ""
    endpoints.forEach(allowedEndpoint => {
      // Matches the strict endpoint, which can be followed by a forward slash or a back slash exactly once,
      // and allows for a query string as well.
      const endpointRegex = new RegExp(`^${allowedEndpoint}(/?|\\\\)($|\\?.*)`)
      if (endpointRegex.test(endpointToCheck)) {
        matchedEndpoint = allowedEndpoint;
      }
    });
    return matchedEndpoint
  }
}

// If a URL has an extra slash or backslash upon arrival, strip it
function removeExtraSlash(expectedEndpoint: string, actualUrl: string) {
  // We know it must match the regex checked, so it starts with expectedEndpoint
  const indexAfterEndpoint: number = expectedEndpoint.length;
  const characterAfterEndpoint: string = actualUrl.charAt(indexAfterEndpoint);
  if (characterAfterEndpoint === '/' || characterAfterEndpoint === '\\') {
    return (
      actualUrl.slice(0, indexAfterEndpoint) +
      actualUrl.slice(indexAfterEndpoint + 1, actualUrl.length)
    );
  }
  return actualUrl;
}
