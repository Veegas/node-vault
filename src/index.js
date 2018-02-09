'use strict';

let debug = require('debug')('node-vault');
let tv4 = require('tv4');
let commands = require('./commands.js');
let mustache = require('mustache');
const axios = require('axios');

module.exports = (config = {}) => {
  // load conditional dependencies
  debug = config.debug || debug;
  tv4 = config.tv4 || tv4;
  commands = config.commands || commands;
  mustache = config.mustache || mustache;

  const client = {};

  function handleVaultResponse(response) {
    if (!response) return Promise.reject(new Error('No response passed'));
    debug(response.status);
    if (response.status !== 200 && response.status !== 204) {
      // handle health response not as error
      if (response.request.path.match(/sys\/health/) !== null) {
        return Promise.resolve(response.data);
      }
      let message;
      if (response.data && response.data.errors && response.data.errors.length > 0) {
        message = response.data.errors[0];
      } else {
        message = `Status ${response.status}`;
      }
      const error = new Error(message);
      return Promise.reject(error);
    }
    // console.log("Response: ", response.data);
    return Promise.resolve(response.data);
  }

  client.handleVaultResponse = handleVaultResponse;

  // defaults
  client.apiVersion = config.apiVersion || 'v1';
  client.endpoint = config.endpoint || process.env.VAULT_ADDR || 'http://127.0.0.1:8200';
  client.token = config.token || process.env.VAULT_TOKEN;

  const requestSchema = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
      },
      method: {
        type: 'string',
      },
    },
    required: ['path', 'method'],
  };

  // Handle any HTTP requests
  client.request = (options = {}) => {
    const valid = tv4.validate(options, requestSchema);
    if (!valid) return Promise.reject(tv4.error);
    let uri = `${client.endpoint}/${client.apiVersion}${options.path}`;
    // Replace variables in uri.
    uri = mustache.render(uri, options.json);
    // Replace unicode encodings.
    uri = uri.replace(/&#x2F;/g, '/');
    options.headers = options.headers || {};
    if (typeof client.token === 'string' && client.token.length) {
      options.headers['X-Vault-Token'] = client.token;
    }
    options.uri = uri;
    options.url = uri;

    debug(options.method, uri);
    // debug(options.json);
    return axios(options).then(handleVaultResponse);
  };

  client.help = (path, requestOptions) => {
    debug(`help for ${path}`);
    const options = Object.assign({}, config.requestOptions, requestOptions);
    options.path = `/${path}?help=1`;
    options.method = 'GET';
    return client.request(options);
  };

  client.write = (path, data, requestOptions) => {
    debug('write %o to %s', data, path);
    const options = Object.assign({}, config.requestOptions, requestOptions);
    options.path = `/${path}`;
    options.json = data;
    options.method = 'PUT';
    return client.request(options);
  };

  client.read = (path, requestOptions) => {
    debug(`read ${path}`);
    const options = Object.assign({}, config.requestOptions, requestOptions);
    options.path = `/${path}`;
    options.method = 'GET';
    return client.request(options);
  };

  client.list = (path, requestOptions) => {
    debug(`list ${path}`);
    const options = Object.assign({}, config.requestOptions, requestOptions);
    options.path = `/${path}`;
    options.method = 'LIST';
    return client.request(options);
  };

  client.delete = (path, requestOptions) => {
    debug(`delete ${path}`);
    const options = Object.assign({}, config.requestOptions, requestOptions);
    options.path = `/${path}`;
    options.method = 'DELETE';
    return client.request(options);
  };

  function validate(json, schema) {
    // ignore validation if no schema
    if (schema === undefined) return Promise.resolve();
    const valid = tv4.validate(json, schema);
    if (!valid) {
      debug(tv4.error.dataPath);
      debug(tv4.error.message);
      return Promise.reject(tv4.error);
    }
    return Promise.resolve();
  }

  function extendOptions(conf, options) {
    const schema = conf.schema.query;
    // no schema for the query -> no need to extend
    if (!schema) return Promise.resolve(options);
    const params = [];
    for (const key of Object.keys(schema.properties)) {
      if (key in options.json) {
        params.push(`${key}=${encodeURIComponent(options.json[key])}`);
      }
    }
    if (params.length > 0) {
      options.path += `?${params.join('&')}`;
    }
    return Promise.resolve(options);
  }

  function generateFunction(name, conf) {
    client[name] = (args = {}) => {
      const options = Object.assign({}, config.requestOptions, args.requestOptions);
      options.method = conf.method;
      options.path = conf.path;
      options.json = args;
      // no schema object -> no validation
      if (!conf.schema) return client.request(options);
      // else do validation of request URL and body
      return validate(options.json, conf.schema.req)
        .then(() => validate(options.json, conf.schema.query))
        .then(() => extendOptions(conf, options))
        .then((extendedOptions) => client.request(extendedOptions));
    };
  }

  client.generateFunction = generateFunction;

  // protecting global object properties from being added
  // enforcing the immutable rule: https://github.com/airbnb/javascript#iterators-and-generators
  // going the functional way first defining a wrapper function
  const assignFunctions = commandName => generateFunction(commandName, commands[commandName]);
  Object.keys(commands).forEach(assignFunctions);

  return client;
};
