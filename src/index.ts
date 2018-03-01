import { ChildProcess, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { EventEmitter } from 'events';
import { parse as urlParser } from 'url';

import {
  MiddlewareParams,
  makeMicroMiddleware,
  makeExpressMiddleware,
  makeConnectMiddleware,
  makeKoaMiddleware,
  instrumentHapi,
} from './middleware';

export type LogLevels = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface AccessLogConfig {
  destination: string;
  requestHeaders?: string[];
  responseHeaders?: string[];
}

export interface ExtensionsConfig {
  strip?: string[];
  blacklist?: string[];
}

// Shortcut to user-configurable fields of EngineConfig "frontend" in default double-proxy mode
export interface FrontendParams {
  extensions?: ExtensionsConfig;
}

// All configuration of default "frontend" (including fields managed by apollo-engine-js)
export interface FrontendConfig extends FrontendParams {
  host: string;
  endpoint?: string;
  endpoints?: string[];
  port: number;
}

// Shortcut to user-configurable fields of EngineConfig "origin" in default double-proxy mode
export interface OriginParams {
  requestTimeout?: string;
  maxConcurrentRequests?: number;
  supportsBatch?: boolean;
  http?: OriginHttpParams;
}

export interface OriginHttpParams {
  trustedCertificates?: string;
  disableCertificateCheck?: boolean;
  overrideRequestHeaders?: {
    [headerName: string]: string;
  };
}

export interface OriginHttpConfig extends OriginHttpParams {
  url: string;
  headerSecret: string;
}

// All configuration of "origin"  (including fields managed by apollo-engine-js)
export interface OriginConfig extends OriginParams {
  http?: OriginHttpConfig;
}

export interface EngineConfig {
  apiKey: string;
  origins?: OriginConfig[];
  frontends?: FrontendConfig[];
  stores?: {
    name: string;
    memcache?: {
      url: string[];
      timeout?: string;
      keyPrefix?: string;
    };
    inMemory?: {
      cacheSize?: number;
    };
  }[];
  sessionAuth?: {
    header?: string;
    cookie?: string;
    tokenAuthUrl?: string;
    store?: string;
  };
  logging?: {
    level?: LogLevels;
    request?: AccessLogConfig;
    query?: AccessLogConfig;
    format?: string;
    destination?: string;
  };
  reporting?: {
    endpointUrl?: string;
    maxAttempts?: number;
    retryMinimum?: string;
    retryMaximum?: string;
    debugReports?: boolean;
    noTraceVariables?: boolean;
    privateHeaders?: string[];
    privateVariables?: string[];
    disabled?: boolean;
    proxyUrl?: string;
  };
  queryCache?: {
    publicFullQueryStore?: string;
    privateFullQueryStore?: string;
  };
  persistedQueries?: {
    store?: string;
    compressionThreshold?: number;
  };
}

// *****************************************************************************
// When you update the list of fields in this interface, also update the
// list sideloadConfigKeys below! (It would be nice to use something like
// https://github.com/kimamula/ts-transformer-keys but running transformers
// is awkward.
// *****************************************************************************
export interface SideloadConfig {
  engineConfig: string | EngineConfig;
  endpoint?: string;
  useConfigPrecisely?: boolean;
  graphqlPort?: number;
  // Should all requests/responses to the proxy be written to stdout?
  dumpTraffic?: boolean;
  // Milliseconds to wait for the proxy binary to start; set to <=0 to wait forever.
  // If not set, defaults to 5000ms.
  startupTimeout?: number;
  origin?: OriginParams;
  frontend?: FrontendParams;
  proxyStdoutStream?: NodeJS.WritableStream;
  proxyStderrStream?: NodeJS.WritableStream;
}
const sideloadConfigKeys = new Set([
  'engineConfig',
  'endpoint',
  'useConfigPrecisely',
  'graphqlPort',
  'dumpTraffic',
  'startupTimeout',
  'origin',
  'frontend',
  'proxyStdoutStream',
  'proxyStderrStream',
]);

export class Engine extends EventEmitter {
  private child: ChildProcess | null;
  private proxyStdoutStream?: NodeJS.WritableStream;
  private proxyStderrStream?: NodeJS.WritableStream;
  private graphqlPort?: number;
  private useConfigPrecisely: boolean;
  private binary: string;
  private config: string | EngineConfig;
  private middlewareParams: MiddlewareParams;
  private running: boolean;
  private startupTimeout: number;
  private originParams: OriginParams;
  private frontendParams: FrontendParams;
  private extraArgs?: string[]; // for testing

  public constructor(config: SideloadConfig) {
    super();

    // It's easy to accidentally pass fields that belong in `engineConfig`
    // at the top level, so make unknown options into errors.
    Object.keys(config).forEach(k => {
      if (!sideloadConfigKeys.has(k)) {
        throw new Error(
          `Unknown option '${k}' in 'new Engine'. Note that the ` +
            `"proxy config file" options need to be passed inside the ` +
            `'engineConfig' option.`,
        );
      }
    });

    this.running = false;
    if (typeof config.startupTimeout === 'undefined') {
      this.startupTimeout = 5000;
    } else {
      this.startupTimeout = config.startupTimeout;
    }
    this.middlewareParams = new MiddlewareParams();
    this.middlewareParams.endpoint = config.endpoint || '/graphql';
    this.middlewareParams.psk = randomBytes(48).toString('hex');
    this.middlewareParams.dumpTraffic = config.dumpTraffic || false;
    this.useConfigPrecisely = config.useConfigPrecisely || false;
    this.originParams = config.origin || {};
    this.frontendParams = config.frontend || {};
    if (config.proxyStdoutStream) {
      this.proxyStdoutStream = config.proxyStdoutStream;
    }
    if (config.proxyStderrStream) {
      this.proxyStderrStream = config.proxyStderrStream;
    }
    if (config.graphqlPort) {
      this.graphqlPort = config.graphqlPort;
    } else {
      const port: any = process.env.PORT;
      if (isFinite(port)) {
        this.graphqlPort = parseInt(port, 10);
      } else if (!this.useConfigPrecisely) {
        throw new Error(
          `Neither 'graphqlPort' nor process.env.PORT is set. ` +
            `In order for Apollo Engine to act as a proxy for your GraphQL server, ` +
            `it needs to know which port your GraphQL server is listening on (this is ` +
            `the port number that comes before '/graphql'). If you see this error, you ` +
            `should make sure to add e.g. 'graphqlPort: 1234' wherever you call new Engine(...).`,
        );
      }
    }
    this.config = config.engineConfig;
    switch (process.platform) {
      case 'darwin': {
        this.binary = require.resolve(
          'apollo-engine-binary-darwin/engineproxy_darwin_amd64',
        );
        break;
      }
      case 'linux': {
        this.binary = require.resolve(
          'apollo-engine-binary-linux/engineproxy_linux_amd64',
        );
        break;
      }
      case 'win32': {
        this.binary = require.resolve(
          'apollo-engine-binary-windows/engineproxy_windows_amd64.exe',
        );
        break;
      }
      default: {
        throw new Error('Unsupported platform');
      }
    }
  }

  public start(): Promise<number> {
    if (this.running) {
      throw new Error('Only call start() on an engine object once');
    }
    this.running = true;
    let finalConfig: string | EngineConfig;
    const endpoint = this.middlewareParams.endpoint;
    const graphqlPort = this.graphqlPort;

    if (this.useConfigPrecisely) {
      // If engineConfig is provided to us as an object rather than a filename,
      // validate that it contains the two required fields, to give a better
      // error message than engineproxy's (since engineproxy's won't suggest
      // removing useConfigPrecisely).
      if (typeof this.config !== 'string') {
        if (this.config.frontends === undefined) {
          throw new Error(
            `Cannot run Apollo Engine with no frontend. Either specify ` +
              `at least one frontend in your engine-config or set useConfigPrecisely ` +
              `to false.`,
          );
        }
        if (this.config.origins === undefined) {
          throw new Error(
            `Cannot run Apollo Engine with no origin. Either specify ` +
              `at least one origin in your engine-config or set useConfigPrecisely ` +
              `to false.`,
          );
        }
      }
      finalConfig = this.config;
    } else {
      let ourConfig: EngineConfig;
      if (typeof this.config === 'string') {
        ourConfig = JSON.parse(readFileSync(
          this.config as string,
          'utf8',
        ) as string);
      } else {
        ourConfig = Object.assign({}, this.config as EngineConfig);
      }

      // Inject frontend.
      const frontend = Object.assign(
        {
          host: '127.0.0.1',
          endpoints: [endpoint],
          port: 0,
        },
        this.frontendParams,
      );
      if (ourConfig.frontends === undefined) {
        ourConfig.frontends = [frontend];
      } else {
        ourConfig.frontends.push(frontend);
      }

      if (ourConfig.origins === undefined) {
        const origin = Object.assign({}, this.originParams) as OriginConfig;
        const defaultHttpOrigin = {
          url: 'http://127.0.0.1:' + graphqlPort + endpoint,
          headerSecret: this.middlewareParams.psk,
        };
        if (origin.http === undefined) {
          origin.http = defaultHttpOrigin;
        } else {
          origin.http = Object.assign(defaultHttpOrigin, origin.http);
        }
        ourConfig.origins = [origin];
      } else {
        // Extend any existing HTTP origins with the chosen PSK:
        // (trust it to fill other fields correctly)
        ourConfig.origins.forEach(origin => {
          if (typeof origin.http === 'object') {
            Object.assign(origin.http, {
              headerSecret: this.middlewareParams.psk,
            });
          }
        });
      }
      finalConfig = ourConfig;
    }

    const spawnChild = () => {
      // We want to read from engineproxy's special listening reporter fd
      // 3 (which we tell it about with an env var). We let it write
      // directly to our stdout and stderr (unless the user passes in
      // their own output streams) so we don't spend CPU copying output
      // around (and if we crash for some reason, engineproxy's output
      // still gets seen). We don't care about engineproxy's stdin.
      //
      // We considered having stdout and stderr always wrapped with a
      // prefix. We used to do this before we switched to JSON but
      // apparently it was slow:
      // https://github.com/apollographql/apollo-engine-js/pull/50#discussion_r153961664
      // Users can use proxyStd*Stream to do this themselves, and we can
      // make it easier if it's popular.
      const stdio = ['ignore', 'inherit', 'inherit', 'pipe'];

      // If we are provided writable streams, ask child_process to create
      // a pipe which we will pipe to them. (We could put the streams
      // directly in `stdio` but this only works for pipes based directly
      // on files.)
      if (this.proxyStdoutStream) {
        stdio[1] = 'pipe';
      }
      if (this.proxyStderrStream) {
        stdio[2] = 'pipe';
      }

      const args: string[] = [];
      const env = Object.assign({}, process.env, {
        LISTENING_REPORTER_FD: '3',
      });
      if (typeof finalConfig === 'string') {
        // Filename with useConfigPrecisely.
        args.push(`-config=${finalConfig}`);
      } else {
        args.push(`-config=env`);
        env.ENGINE_CONFIG = JSON.stringify(finalConfig);
      }

      if (this.extraArgs) {
        this.extraArgs.forEach(a => args.push(a));
      }

      const child = spawn(this.binary, args, {
        stdio,
        env,
      });
      this.child = child;

      // Hook up custom logging streams, if provided.
      if (this.proxyStdoutStream) {
        child.stdout.pipe(this.proxyStdoutStream);
      }
      if (this.proxyStderrStream) {
        child.stderr.pipe(this.proxyStderrStream);
      }

      let listeningAddress = '';
      child.stdio[3].on('data', chunk => {
        listeningAddress += chunk.toString();
      });
      child.stdio[3].on('end', () => {
        // If we read something, then it started. (If not, then this is
        // probably just end of process cleanup.)
        if (listeningAddress !== '') {
          this.middlewareParams.uri = `http://${listeningAddress}`;
          // Notify that proxy has started.
          this.emit('start');
        }
      });
      // Re-emit any errors from talking to engineproxy.
      // XXX Not super clear if this will happen in practice, but at least
      //     if it does, doing it this way will make it clear that the error
      //     is coming from Engine.
      child.stdio[3].on('error', err => this.emit('error', err));

      // Connect shutdown hooks:
      child.on('exit', (code, signal) => {
        // Wipe the URI, so middleware doesn't route to dead process:
        this.middlewareParams.uri = '';

        if (!this.running) {
          // It's not an error if we think it's our fault.
          return;
        }
        if (code === 78) {
          this.emit(
            'error',
            new Error('Engine crashed due to invalid configuration.'),
          );
          return;
        }

        if (code != null) {
          this.emitRestarting(`Engine crashed unexpectedly with code: ${code}`);
        }
        if (signal != null) {
          this.emitRestarting(
            `Engine was killed unexpectedly by signal: ${signal}`,
          );
        }
        spawnChild();
      });
    };

    spawnChild();

    return new Promise((resolve, reject) => {
      let cancelTimeout: NodeJS.Timer;
      if (this.startupTimeout > 0) {
        cancelTimeout = setTimeout(() => {
          this.running = false;
          if (this.child) {
            this.child.kill('SIGKILL');
            this.child = null;
          }
          return reject(Error('engineproxy timed out'));
        }, this.startupTimeout);
      }

      this.on('start', () => {
        clearTimeout(cancelTimeout);
        const port = urlParser(this.middlewareParams.uri).port;
        if (!port) {
          return reject('engineproxy url is bad');
        }
        resolve(parseInt(port, 10));
      });
    });
  }

  public microMiddleware(): (fn: Function) => void {
    return makeMicroMiddleware(this.middlewareParams);
  }

  public expressMiddleware(): (req: any, res: any, next: any) => void {
    return makeExpressMiddleware(this.middlewareParams);
  }

  public connectMiddleware(): (req: any, res: any, next: any) => void {
    return makeConnectMiddleware(this.middlewareParams);
  }

  public koaMiddleware(): (ctx: any, next: any) => void {
    return makeKoaMiddleware(this.middlewareParams);
  }

  public instrumentHapiServer(server: any) {
    instrumentHapi(server, this.middlewareParams);
  }

  public stop(): Promise<void> {
    if (this.child === null) {
      throw new Error('No engine instance running...');
    }
    const childRef = this.child;
    this.child = null;
    this.running = false;
    return new Promise(resolve => {
      childRef.on('exit', () => {
        resolve();
      });
      childRef.kill();
    });
  }

  private emitRestarting(error: string) {
    if (!this.emit('restarting', new Error(error))) {
      // No listeners; default to console.error.
      console.error(error);
    }
  }
}
