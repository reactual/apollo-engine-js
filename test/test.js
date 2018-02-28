const { Engine } = require('../lib/index');

exports.testEngine = (path, options = {}) => {
  path = path || '/graphql';

  return new Engine({
    ...options,
    endpoint: path,
    engineConfig: {
      logging: {
        level: 'warn',
      },
      reporting: {
        disabled: true,
      },
    },
    graphqlPort: 1,
    frontend: {
      extensions: {
        strip: ['tracing'],
      },
    },
  });
};
