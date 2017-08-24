import { Request, Response, NextFunction } from 'express'
import { Context } from 'koa'
import { Server } from 'hapi'
import * as request from 'request'

export function makeExpressMiddleware(prefix: string, uri: string, psk: string) {
    return function (req: Request, res: Response, next: NextFunction) {
        if (!req.path.startsWith(prefix)) next();
        else if (req.headers['x-engine-from'] === psk) next();
        else req.pipe(request(uri + prefix)).pipe(res);
    }
}

export function makeConnectMiddleware(prefix: string, uri: string, psk: string) {
    return function (req: any, res: any, next: any) {
        if (!req.originalUrl.startsWith(prefix)) next();
        else if (req.headers['x-engine-from'] === psk) next();
        else req.pipe(request(uri + prefix)).pipe(res);
    }
}

export function makeKoaMiddleware(prefix: string, uri: string, psk: string) {
    return function (ctx: Context, next: () => Promise<any>) {
        if (!ctx.originalUrl.startsWith(prefix)) return next();
        else if (ctx.req.headers['x-engine-from'] === psk) return next();
        else return new Promise((resolve) => {
            ctx.req.pipe(request(uri + prefix, (error, response, body) => {
                if (response.statusCode) ctx.response.status = response.statusCode;
                ctx.response.set(JSON.parse(JSON.stringify(response.headers)));
                ctx.response.body = body;
                resolve();
            }));
        });
    }
}

export function instrumentHapi(server: Server, prefix: string, uri: string, psk: string) {
    server.ext('onRequest', (req, reply) => {
        const path = req.url.path;
        req.raw.req.headers['x-engine-from'];
        if (!path || !path.startsWith(prefix)) {
            return reply.continue();
        }
        else if (req.raw.req.headers['x-engine-from'] === psk) {
            return reply.continue();
        }
        else {
            const r = reply(new Promise((resolve) => {
                req.raw.req.pipe(request(uri + prefix, (error, response, body) => {
                    const obj = JSON.parse(JSON.stringify(response.headers));
                    if (response.statusCode) r.code(response.statusCode);
                    Object.keys(obj).forEach(key => {
                        r.header(key, obj[key]);
                    });
                    resolve(body);
                }));
            }));
        }
    });
}
