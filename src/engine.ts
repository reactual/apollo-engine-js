import { Application as ExpressApp } from 'express';
import { Server as ConnectApp } from 'connect';
import { Server as HttpServer } from 'http';
import * as KoaApp from 'koa';

import { EngineConfig, StartOptions, ListeningAddress } from './types';
import { ApolloEngineLauncher, joinHostPort } from './launcher';
import { EventEmitter } from 'events';

export interface ListenOptions {
  port: number;
  graphqlPaths?: string[]; // default: ['/graphql']
  host?: string; // default: ''. This is where engineproxy listens.
  innerHost?: string; // default: '127.0.0.1'. This is where Node listens.
  startOptions?: StartOptions;

  httpServer?: HttpServer;
  expressApp?: ExpressApp;
  connectApp?: ConnectApp;
  koaApp?: KoaApp;
}

export class ApolloEngine extends EventEmitter {
  private config: EngineConfig;
  private launcher: ApolloEngineLauncher;
  private httpServer: HttpServer;

  public constructor(config: EngineConfig) {
    super();
    this.config = config;
    this.launcher = new ApolloEngineLauncher(config);
  }

  public listen(options: ListenOptions, listenCallback: (la: ListeningAddress)=>void) {
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
      const innerAddress = httpServer.address();
      const defaults = {
        frontendHost: options.host,
        frontendPort: options.port,
        graphqlPaths: options.graphqlPaths || ['/graphql'],
        originUrl: `http://${joinHostPort(innerAddress.address, innerAddress.port)}`,
        // Support multiple graphqlPaths.
        useFrontendPathForDefaultOrigin: true,
      };

      const startOptions = Object.assign({}, options.startOptions);
      startOptions.extraArgs = [
        ...(startOptions.extraArgs || []),
        `-defaults=${JSON.stringify(defaults)}`,
      ];

      this.launcher
        .start(startOptions)
        .then(engineListeningAddress => {
          listenCallback(engineListeningAddress);
        })
        .catch(error => this.emit('error', error));
    });
  }

  public async stop() {
    await this.launcher.stop();
    // XXX Should we also wait for all current connections to be closed?
    this.httpServer.close();
  }

  // FIXME hapiListener
}
