import {Request, Response, NextFunction} from 'express'
import {Context} from 'koa'
import {Server} from 'hapi'
import * as request from 'request'
import {IncomingMessage, ServerResponse} from 'http';
import { parse as urlParser } from 'url';

export class MiddlewareParams {
    public endpoint: string;
    public uri: string;
    public psk: string;
    public dumpTraffic: boolean;
}

export function makeMicroMiddleware(params: MiddlewareParams) {
    const endpointRegex = getEndpointRegex(params.endpoint);
    return function(fn: Function) {
        return function (req: IncomingMessage, res: ServerResponse) {
            const requestUrl = req.url || '';
            if (!params.uri || !endpointRegex.test(requestUrl)) return fn(req, res);
            else if (req.method !== 'GET' && req.method !== 'POST') return fn(req, res);
            else if (req.headers['x-engine-from'] === params.psk) return fn(req, res);
            else {
                req.url = removeExtraSlash(params.endpoint, requestUrl);
                proxyRequest(params, req, res);
            }
        }
    }
}

export function makeExpressMiddleware(params: MiddlewareParams) {
    const endpointRegex = getEndpointRegex(params.endpoint);
    return function (req: Request, res: Response, next: NextFunction) {
        if (!params.uri || !endpointRegex.test(req.originalUrl)) {
            next();
        }
        else if (req.method !== 'GET' && req.method !== 'POST') next();
        else if (req.headers['x-engine-from'] === params.psk) next();
        else {
            req.url = removeExtraSlash(params.endpoint, req.originalUrl);
            proxyRequest(params, req, res);
        }
    }
}

export function makeConnectMiddleware(params: MiddlewareParams) {
    const endpointRegex = getEndpointRegex(params.endpoint);
    return function (req: any, res: any, next: any) {
        if (!params.uri || !endpointRegex.test(req.originalUrl)) next();
        else if (req.method !== 'GET' && req.method !== 'POST') next();
        else if (req.headers['x-engine-from'] === params.psk) next();
        else {
            req.url = removeExtraSlash(params.endpoint, req.originalUrl);
            proxyRequest(params, req, res);
        }
    }
}

export function makeKoaMiddleware(params: MiddlewareParams) {
    return function (ctx: Context, next: () => Promise<any>) {
        if (!params.uri || ctx.path !== params.endpoint) return next();
        else if (ctx.req.headers['x-engine-from'] === params.psk) return next();
        else if (ctx.req.method !== 'GET' && ctx.req.method !== 'POST') return next();
        else return new Promise((resolve, reject) => {
                ctx.req.pipe(request(params.uri + ctx.originalUrl, (error, response, body) => {
                    if(!!error || !response || !response.statusCode) {
                        reject(new Error('Missing response from Engine proxy.'));
                    }
                    else {
                        ctx.response.status = response.statusCode;
                        ctx.response.set(JSON.parse(JSON.stringify(response.headers)));
                        ctx.response.body = body;
                        resolve();
                    }
                }));
            });
    }
}


export async function instrumentHapi(server: Server, params: MiddlewareParams) {
    server.ext('onRequest', (req, h) => {
        if (!params.uri) return h.continue;
        const path = req.url.pathname;
        if (!path || path !== params.endpoint) return h.continue;
        else if (req.method !== 'get' && req.method !== 'post') return h.continue;
        else if (req.headers['x-engine-from'] === params.psk) {
            console.log('wow engine responded');
            return h.continue;
        }
        // The error is somewhere in this step. Engine never processes the query at all
        else {
            proxyRequest(params, req.raw.req, req.raw.res);
            return h.continue;
        }
    });
}

function proxyRequest(params: MiddlewareParams, req: IncomingMessage, res: ServerResponse) {
    if (params.dumpTraffic) {
        req.pipe(process.stdout);
    }

    const proxyRes = req.pipe(request({
        uri: params.uri + req.url,
        forever: true,
        headers: { 'host': req.headers['host'] },
    }))
        .on('error', (err) => {
            console.error(err);
            res.writeHead(503);
            res.end();
        });

    if (params.dumpTraffic) {
        proxyRes.pipe(process.stdout);
    }
    proxyRes.pipe(res);
}

// Matches the strict endpoint, which can be followed by a forward slash or a back slash exactly once,
// and allows for a query string as well.
function getEndpointRegex(endpoint: string) : RegExp {
    return new RegExp(`^${endpoint}(/?|\\\\)($|\\?.*)`);
}

// If a URL has an extra slash or backslash upon arrival, strip it
function removeExtraSlash(expectedEndpoint: string, actualUrl: string) {
    // We know it must match the regex checked, so it starts with expectedEndpoint
    const indexAfterEndpoint : number = expectedEndpoint.length;
    const characterAfterEndpoint : string = actualUrl.charAt(indexAfterEndpoint);
    if(characterAfterEndpoint === '/' || characterAfterEndpoint === '\\') {
        return actualUrl.slice(0, indexAfterEndpoint) + actualUrl.slice(indexAfterEndpoint+1, actualUrl.length);
    }
    return actualUrl;
}