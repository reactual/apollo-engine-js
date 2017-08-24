import { randomBytes } from 'crypto'
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { ChildProcess, execFile } from 'child_process'

import { getPortPromise } from 'portfinder'

import { makeExpressMiddleware, makeConnectMiddleware, makeKoaMiddleware, instrumentHapi } from './middleware'

export type LogLevels = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface EngineConfig {
    apiKey: string,
    reporting?: {
        endpointUrl?: string
    },
    logcfg?: {
        level: LogLevels
    },
    stores?: [
        {
            name: string,
            epoch?: number,
            timeout?: string,
            memcaches: [
                {
                    url: string
                }
            ]
        }
    ],
    operations?: [
        {
            signature: string,
            perSession?: boolean,
            caches: [
                {
                    ttl: number,
                    store: string
                }
            ]
        }
    ],
    sessionAuth?: {
        header: string,
        store?: string,
        tokenAuthUrl?: string
    }
}

export interface SideloadConfig {
    engineConfig: string | EngineConfig,
    endpoint?: string,
    graphqlPort?: number
}

export class Engine {
    private child: ChildProcess | null;
    private endpoint: string;
    private graphqlPort: number;
    private enginePort: number;
    private binary: string;
    private config: string | EngineConfig;
    private headerSecret: string;
    public constructor(config: SideloadConfig) {
        if (config.endpoint) {
            this.endpoint = config.endpoint;
        } else {
            this.endpoint = '/graphql';
        }
        if (config.graphqlPort) {
            this.graphqlPort = config.graphqlPort;
        } else {
            const port = process.env.PORT;
            if (port) {
                this.graphqlPort = parseInt(port, 10);
            } else {
                throw new Error('process.env.PORT is not set!');
            }
        }
        this.config = config.engineConfig;
        this.headerSecret = randomBytes(48).toString("hex")
        switch (process.platform) {
            case 'darwin': {
                this.binary = 'engineproxy_darwin_amd64';
                break;
            }
            case 'linux': {
                this.binary = 'engineproxy_linux_amd64';
                break;
            }
            case 'win32': {
                this.binary = 'engineproxy_windows_amd64.exe';
                break;
            }
            default: {
                throw new Error('Unsupported platform');
            }
        }
    }
    public start(): Promise<any> {
        const config = this.config;
        const endpoint = this.endpoint;
        const graphqlPort = this.graphqlPort;
        return getPortPromise({
            host: '127.0.0.1'
        }).then((port) => {
            this.enginePort = port;
            const binaryPath = resolve(__dirname, '../bin', this.binary);

            let child = this.child;
            if (typeof config === 'string') {
                const env = Object.assign({ 'ENGINE_CONFIG': port + ',' + endpoint + ',' + graphqlPort + ',' + this.headerSecret }, process.env);
                child = execFile(binaryPath, ['-config=' + config, '-sload=true', '-restart=true'], { 'env': env }, (err: Error) => {
                    if (err) console.error(err);
                });
                child.stdout.pipe(process.stdout);
                child.stderr.pipe(process.stderr);
                child.on('exit', () => {
                    if (child != null) {
                        throw new Error('Engine crashed unexpectedly');
                    }
                });
            } else {
                const sideloadConfig = JSON.parse(JSON.stringify(config));
                sideloadConfig.frontends = [{ 'host': '127.0.0.1', 'endpoint': endpoint, 'port': port }];
                sideloadConfig.origins = [{ url: 'http://127.0.0.1:' + graphqlPort + endpoint, headerSecret: this.headerSecret }];
                const env = { 'env': Object.assign({ 'ENGINE_CONFIG': JSON.stringify(sideloadConfig) }, process.env) };
                child = execFile(binaryPath, ['-config=env', '-restart=true'], env);
                child.stdout.pipe(process.stdout);
                child.stderr.pipe(process.stderr);
                child.on('exit', () => {
                    if (child != null) {
                        throw new Error('Engine crashed unexpectedly')
                    }
                });
            }
        });
    }

    public expressMiddleware(): (req: any, res: any, next: any) => void {
        return makeExpressMiddleware(this.endpoint, 'http://127.0.0.1:' + this.enginePort, this.headerSecret);
    }

    public connectMiddleware(): (req: any, res: any, next: any) => void {
        return makeConnectMiddleware(this.endpoint, 'http://127.0.0.1:' + this.enginePort, this.headerSecret);
    }

    public koaMiddleware(): (ctx: any, next: any) => void {
        return makeKoaMiddleware(this.endpoint, 'http://127.0.0.1:' + this.enginePort, this.headerSecret);
    }

   public instrumentHapiServer(server: any) {
       instrumentHapi(server, this.endpoint, 'http://127.0.0.1:' + this.enginePort, this.headerSecret);
   }

    public stop() {
        if (this.child == null) {
            throw new Error('No engine instance running...');
        }
        const childRef = this.child;
        this.child = null;
        childRef.kill();
    }
}
