import { readFileSync } from 'fs';
import { resolve } from 'path';
import { ChildProcess, execFile } from 'child_process'

import { getPortPromise } from 'portfinder'

import { makeExpressMiddleware, makeConnectMiddleware } from './middleware'

export type LogLevels = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface EngineConfig {
    reporting: {
        apiKey: string,
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
            caches: [
                {
                    perSession?: boolean,
                    ttl: number,
                    store: string
                }
            ]
        }
    ],
    sessionAuth?: {
        store: string,
        header: string,
        tokenAuthUrl: string
    }
}

export class Engine {
    private child: ChildProcess | null;
    private endpoint: string;
    private graphqlPort: number;
    private enginePort: number;
    private binary: string;
    private config: string | EngineConfig;
    private headerSecret: string;
    public constructor(config: string | EngineConfig, endpoint: string, graphqlPort: number, headerSecret: string) {
        this.endpoint = endpoint;
        this.graphqlPort = graphqlPort;
        this.config = config;
        this.headerSecret = headerSecret;
        switch (process.platform) {
            case 'darwin': {
                this.binary = 'engine-darwin64';
                break;
            }
            case 'linux': {
                this.binary = 'engine-linux64';
                break;
            }
            default: {
                throw new Error('Unsupported platform');
            }
        }
    }
    public start(callback: (err?: Error) => void) {
        let config = this.config;
        let endpoint = this.endpoint;
        let graphqlPort = this.graphqlPort;
        getPortPromise({
            host: '127.0.0.1'
        }).then((port) => {
            this.enginePort = port;
            const binaryPath = resolve(__dirname, '../bin', this.binary);

            let child = this.child;
            if (typeof config === 'string') {
                let env = Object.assign({ 'ENGINE_CONFIG': port + ',' + endpoint + ',' + graphqlPort + ',' + this.headerSecret }, process.env);
                child = execFile(binaryPath, ['-config=' + config, '-sload=true', '-restart=true'], { 'env': env }, (err: Error) => {
                    if (err) console.error(err);
                });
                child.stdout.pipe(process.stdout);
                child.stderr.pipe(process.stderr);
                child.on('exit', function () {
                    if (child != null) {
                        throw new Error('Engine crashed unexpectedly');
                    }
                });
            } else {
                let sideloadConfig = JSON.parse(JSON.stringify(config));
                sideloadConfig.frontends = [{ 'host': '127.0.0.1', 'endpoint': endpoint, 'port': port }];
                sideloadConfig.origins = [{ url: 'http://127.0.0.1:' + graphqlPort + endpoint, headerSecret: this.headerSecret }];
                let env = { 'env': Object.assign({ 'ENGINE_CONFIG': JSON.stringify(sideloadConfig) }, process.env) };
                child = execFile(binaryPath, ['-config=env', '-restart=true'], env);
                child.stdout.pipe(process.stdout);
                child.stderr.pipe(process.stderr);
                child.on('exit', function () {
                    if (child != null) {
                        throw new Error('Engine crashed unexpectedly')
                    }
                });
            }
            callback();
        }).catch((err) => {
            callback(err);
        });
    }

    public expressMiddleware(): (req: any, res: any, next: any) => void {
        return makeExpressMiddleware(this.endpoint, 'http://127.0.0.1:' + this.enginePort, this.headerSecret);
    }

    public connectMiddleware(): (req: any, res: any, next: any) => void {
        return makeConnectMiddleware(this.endpoint, 'http://127.0.0.1:' + this.enginePort, this.headerSecret);
    }

    public stop() {
        if (this.child == null) {
            throw new Error('No engine instance running...');
        }
        let childRef = this.child;
        this.child = null;
        childRef.kill();
    }
}
