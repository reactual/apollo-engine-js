import { Application as ExpressApp } from 'express';
import { Server as ConnectApp } from 'connect';
import { Server as HttpServer } from 'http';
import * as KoaApp from 'koa';

import { EngineConfig, StartOptions, ListeningAddress } from './types';
import { ApolloEngineLauncher, joinHostPort } from './launcher';
import { EventEmitter } from 'events';

export interface MeteorListenOptions {
  graphqlPaths?: string[]; // default: ['/graphql']
  innerHost?: string; // default: '127.0.0.1'. This is where Node listens.
  startOptions?: StartOptions;
}

export interface CoreListenOptions extends MeteorListenOptions {
  port: number;
  host?: string; // default: ''. This is where engineproxy listens.
}

export interface ListenOptions extends CoreListenOptions {
  httpServer?: HttpServer;
  expressApp?: ExpressApp;
  connectApp?: ConnectApp;
  koaApp?: KoaApp;
}

export interface HapiListenOptions extends CoreListenOptions {}

export class ApolloEngine extends EventEmitter {
  // Primarily useful if you're having engine listen on 0 for tests.
  public engineListeningAddress: ListeningAddress;

  private config: EngineConfig;
  private launcher: ApolloEngineLauncher;
  private httpServer: HttpServer;

  public constructor(config: EngineConfig) {
    super();
    this.config = config;
    this.launcher = new ApolloEngineLauncher(config);
  }

  public listen(options: ListenOptions, listenCallback: () => void) {
    if (options.port === undefined) {
      throw new Error(
        'Must provide the port that your app will be accessible on as "port"',
      );
    }
    let httpServer: HttpServer;
    let appsProvided = 0;
    if (options.httpServer) {
      httpServer = options.httpServer;
      appsProvided++;
    }
    if (options.expressApp) {
      httpServer = new HttpServer(options.expressApp);
      appsProvided++;
    }
    if (options.connectApp) {
      httpServer = new HttpServer(options.connectApp);
      appsProvided++;
    }
    if (options.koaApp) {
      httpServer = new HttpServer(options.koaApp.callback());
      appsProvided++;
    }

    if (appsProvided === 0) {
      throw new Error(
        'Must provide "httpServer", "expressApp", "connectApp", or "koaApp"',
      );
    }
    if (appsProvided > 1) {
      throw new Error(
        'Must only provide one of "httpServer", "expressApp", "connectApp", and "koaApp"',
      );
    }
    this.httpServer = httpServer!;
    // Note: if the listen fails, then httpServer will emit an error, and
    // there's no way for our user to catch it. However, this is exactly the
    // same situation as express/koa/connect's listen() method, so that's OK; if
    // the user wants to listen for that error they can spend one line turning
    // their app into an http.Server and pass that in instead.
    this.httpServer.listen({ port: 0, host: options.innerHost }, () => {
      // The Node server is now listening, so we can figure out what its address
      // is!
      this.startEngine(httpServer.address(), options).then(() =>
        listenCallback(),
      );
    });
  }

  public async stop() {
    await this.launcher.stop();
    // XXX Should we also wait for all current connections to be closed?
    this.httpServer.close();
  }

  public meteorListen(webApp: any, options: MeteorListenOptions = {}) {
    // Try to use an API to be added in Meteor 1.6.2 that lets us override the
    // built-in listen call.
    if (webApp.startListening) {
      webApp.startListening = (
        httpServer: HttpServer,
        listenOptions: { port?: number; host?: string; path?: string },
        cb: () => void,
      ) => {
        if (listenOptions.path !== undefined) {
          throw Error('Engine does not support listening on a path');
        }
        if (listenOptions.port === undefined) {
          throw Error('Engine done not support listening without a port');
        }
        this.listen(
          { ...options, port: listenOptions.port, host: listenOptions.host },
          cb,
        );
      };
      return;
    }

    // Hacky pre-1.6.2 approach. The downside to this way is that the dev-mode
    // app runner (and any in-app onListening calls) gets informed that the app
    // is listening when the inner server is listening but before Engine is
    // listening, which means that (eg) requests buffered in the dev-mode proxy
    // might fail.
    const port = +(process.env.PORT || 0);
    process.env.PORT = '0';
    webApp.onListening(() => {
      this.startEngine(webApp.httpServer.address(), { ...options, port });
    });
  }

  public async hapiListener(options: HapiListenOptions) {
    const httpServer = new HttpServer();
    const p = new Promise((resolve, reject) => {
      this.once('error', reject);
      this.listen({ ...options, httpServer }, resolve);
    });
    await p;

    // The autoListen:false feature of hapi is semi-broken: some key
    // functionality depends on the 'listening' event being evoked even if you
    // told it it's already listening. Here's a fun hack to make sure we call it
    // anyway!
    function callListeningImmediately(event: String, listening: Function) {
      if (event !== 'listening') {
        return;
      }
      httpServer.removeListener('newListener', callListeningImmediately);
      process.nextTick(() => httpServer.emit('listening'));
    }
    httpServer.on('newListener', callListeningImmediately);
    return httpServer;
  }

  private async startEngine(
    innerAddress: { port: number; address: string },
    options: CoreListenOptions,
  ) {
    const defaults = {
      frontendHost: options.host,
      frontendPort: options.port,
      graphqlPaths: options.graphqlPaths || ['/graphql'],
      originUrl: `http://${joinHostPort(
        innerAddress.address,
        innerAddress.port,
      )}`,
      // Support multiple graphqlPaths.
      useFrontendPathForDefaultOrigin: true,
    };

    const startOptions = Object.assign({}, options.startOptions);
    startOptions.extraArgs = [
      ...(startOptions.extraArgs || []),
      `-defaults=${JSON.stringify(defaults)}`,
    ];

    try {
      this.engineListeningAddress = await this.launcher.start(startOptions);
    } catch (error) {
      this.emit('error', error);
    }
  }
}
