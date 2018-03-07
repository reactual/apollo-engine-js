export { ApolloEngineLauncher } from './launcher';
export { ApolloEngine } from './engine';

export class Engine {
  public constructor() {
    throw new Error(
      `As of apollo-engine 1.x, the Engine class has been replaced with a simpler API. See https://www.apollographql.com/docs/engine/1.0-migration.html to learn how to migrate.`,
    );
  }
}
