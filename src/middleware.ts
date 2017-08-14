import { Request, Response, NextFunction } from 'express'
import * as request from 'request'

export function makeExpressMiddleware(prefix: string, uri: string, psk: string) {
    return function(req: Request, res: Response, next: NextFunction) {
        if(!req.path.startsWith(prefix)) next();
        else if(req.headers['x-engine-from'] === psk) next();
        else req.pipe(request(uri + prefix)).pipe(res);
    }
}

export function makeConnectMiddleware(prefix: string, uri: string, psk: string) {
    return function(req: any, res: any, next: any) {
        if(!req.originalUrl.startsWith(prefix)) next();
        else if(req.headers['x-engine-from'] === psk) next();
        else req.pipe(request(uri + prefix)).pipe(res);
    }
}
