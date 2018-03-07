import { buildSchema, GraphQLSchema } from 'graphql';
import * as request from 'request';

export const schema = buildSchema(`
  type Query {
    hello: String @cacheControl(maxAge: 30)
    errorTrigger: String
  }
`);

export const rootValue = {
  hello: () => {
    return 'Hello World';
  },
  errorTrigger: () => {
    throw new Error('Kaboom');
  },
};

export function verifyEndpointSuccess(url: string, hasTracing: boolean) {
  return new Promise(resolve => {
    request.post(
      {
        url,
        json: true,
        body: { query: '{ hello }' },
      },
      (err, response, body) => {
        expect(err).toBe(null);
        expect(body['data']['hello']).toBe('Hello World');
        if (hasTracing) {
          expect(
            body['extensions'] && body['extensions']['tracing'],
          ).toBeDefined();
        } else {
          expect(
            body['extensions'] && body['extensions']['tracing'],
          ).toBeUndefined();
        }
        resolve(body);
      },
    );
  });
}

export function verifyEndpointBatch(url: string, hasTracing: boolean) {
  return new Promise(resolve => {
    request.post(
      {
        url,
        json: true,
        body: [{ query: '{ hello }' }, { query: '{ hello }' }],
      },
      (err, response, bodies) => {
        expect(err).toBe(null);
        expect(bodies.length).toBe(2);

        bodies.forEach((body: any) => {
          expect(body['data']['hello']).toBe('Hello World');
          if (hasTracing) {
            expect(
              body['extensions'] && body['extensions']['tracing'],
            ).toBeDefined();
          } else {
            expect(
              body['extensions'] && body['extensions']['tracing'],
            ).toBeUndefined();
          }
        });

        resolve();
      },
    );
  });
}

export function verifyEndpointFailure(url: string) {
  return new Promise(resolve => {
    request.post(
      {
        url,
        json: true,
        body: { query: '{ validButDoesNotComplyToSchema }' },
      },
      (err, response, body) => {
        if (response.statusCode === 200) {
          // Proxy responds with an error-ed 200:
          expect(response.body['errors'][0]['message']).toBe(
            'Cannot query field "validButDoesNotComplyToSchema" on type "Query".',
          );
        } else {
          // Express responds with a 400
          expect(response.statusCode).toBe(400);
        }
        resolve();
      },
    );
  });
}

export function verifyEndpointError(url: string) {
  return new Promise(resolve => {
    request.post(
      {
        url,
        json: true,
        body: { query: '{ errorTrigger }' },
      },
      (err, response, body) => {
        expect(err).toBe(null);
        expect(response.statusCode).toBe(200);
        expect(body['errors'][0]['message']).toBe('Kaboom');
        resolve();
      },
    );
  });
}

export function verifyEndpointGet(url: string, hasTracing: boolean) {
  return new Promise(resolve => {
    let query = '{ hello }';
    request.get(
      {
        url: `${url}?query=${encodeURIComponent(query)}`,
        json: true,
      },
      (err, response, body) => {
        expect(err).toBe(null);
        expect(response.statusCode).toBe(200);
        expect(body['data']['hello']).toBe('Hello World');
        if (hasTracing) {
          expect(
            body['extensions'] && body['extensions']['tracing'],
          ).toBeDefined();
        } else {
          expect(
            body['extensions'] && body['extensions']['tracing'],
          ).toBeUndefined();
        }
        resolve();
      },
    );
  });
}
