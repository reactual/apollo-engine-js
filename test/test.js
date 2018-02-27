const {Engine} = require('../lib/index');

exports.testEngine = (path) => {
  path = path || '/graphql';

  return new Engine({
    endpoints: [path],
    engineConfig: {
      logging: {
        level: 'warn'
      },
      reporting: {
        disabled: true
      }
    },
    graphqlPort: 1,
    frontend: {
      extensions: {
        strip: ['tracing'],
      }
    }
  });
};
