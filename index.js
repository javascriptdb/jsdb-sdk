import {parseFiles, serializeFiles} from "./utils.js";
import EventEmitter from "events";

class Auth extends EventEmitter {
  token;
  userId;

  constructor(backendUrl) {
    super()
    if (typeof process !== 'object') {
      this.token = localStorage.token;
      this.userId = localStorage.userId;
    }
    this.on('newListener', (event, listener) => {
      if (event === 'tokenChanged') {
        listener(this.token);
      }
    })
    this.backendUrl = backendUrl;
  }

  isLoggedIn = () => !!this.token;

  getDefaultHeaders = () => ({
    'Authorization': this.token || '',
    'Content-Type': 'application/json'
  })

  signIn = async (credentials) => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    credentials.password = decoder.decode(await crypto.subtle.digest('SHA-256', encoder.encode(credentials.password)));
    const response = await fetch(`${this.backendUrl}/auth/sign-in`, {
      method: 'POST',
      mode: 'cors',
      headers: {
        ...this.getDefaultHeaders(),
      },
      body: JSON.stringify({credentials}) // body data type must match "Content-Type" header
    });
    if (response.status === 200) {
      const jsonResponse = await response.json();
      this.token = jsonResponse.token;
      this.userId = jsonResponse.userId;
      if (typeof process !== 'object') {
        localStorage.token = this.token;
        localStorage.userId = this.userId;
      }
      this.emit('tokenChanged', this.token);
      return true;
    } else {
      throw new Error(`Error logging in, verify email and password`);
    }
  }

  createAccount = async (credentials) => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    credentials.password = decoder.decode(await crypto.subtle.digest('SHA-256', encoder.encode(credentials.password)));
    const response = await fetch(`${this.backendUrl}/auth/sign-up`, {
      method: 'POST',
      mode: 'cors',
      headers: {
        ...this.getDefaultHeaders(),
      },
      body: JSON.stringify({credentials}) // body data type must match "Content-Type" header
    });
    if (response.status === 200) {
      const jsonResponse = await response.json();
      this.token = jsonResponse.token;
      this.userId = jsonResponse.userId;
      if (typeof process !== 'object') {
        localStorage.token = this.token;
        localStorage.userId = this.userId;
      }
      this.emit('tokenChanged', this.token);
      return true;
    } else {
      throw new Error(`Error creating account`);
    }
  }
}

export default function index(_backendUrl) {
  const backendUrl = _backendUrl;
  const auth = new Auth(backendUrl);

  const getDefaultHeaders = () => {
    const headers = {
      'Content-Type': 'application/json'
    }
    if (auth.token) {
      headers['Authorization'] = auth.token;
    }
    return headers;
  }

  const apiRequest = async (path, body) => {
    const response = await fetch(`${backendUrl}${path}`, {
      method: 'POST',
      mode: 'cors',
      headers: {
        ...getDefaultHeaders(),
      },
      body: JSON.stringify(body) // body data type must match "Content-Type" header
    });
    if (response.headers.get("content-type").includes('json')) {
      return response.json();
    }
  }

  const proxiedArray = (array, collection) => {

    return new Proxy(array, {
      async set(target, property, value, receiver) {
        if (Number.isInteger(Number(property))) {
          apiRequest(
            '/db/set',
            {collection, value}
          )
        }
        return Reflect.set(...arguments);
      }
    });
  }

  class DatabaseArray extends Array {
    collection;
    proxy = new Proxy(this, {
      set: function (target, property, value, receiver) {
        target[property] = value;
        return true;
      },
      get(target, property, receiver) {
        const propertyHandler = {
          filter: async (filterFunction) => {
            return proxiedArray(await apiRequest(
              '/db/filter',
              {
                collection: target.collection,
                filterFunction: filterFunction
                  .toString()
                  .replaceAll('auth.userId', JSON.stringify(auth.userId))
              }
            ), target.collection)
          },
          forEach: async (callback) => {
            const result = await apiRequest(
              '/db/getAll',
              {collection: target.collection}
            );
            return result.forEach(callback);
          },
          push: async (value) => {
            const result = await apiRequest(
              '/db/push',
              {collection: target.collection, value}
            );
            return result.count;
          }
        }
        return propertyHandler[property] || Reflect.get(target, property, receiver);;
      }
    });

    constructor(collection, ...args) {
      super(...args);
      this.collection = collection;
      return this.proxy;
    }
  }

  class DatabaseMap extends Map {
    collection;
    proxy = new Proxy(this, {
      async get(target, property, receiver) {
        const response = await fetch(`${backendUrl}/db/get`, {
          method: 'POST',
          mode: 'cors',
          headers: {
            ...getDefaultHeaders(),
          },
          body: JSON.stringify([target.collection, property]) // body data type must match "Content-Type" header
        });
        const data = await response.json();
        await parseFiles(data);
        return data;
      },
      async set(target, property, value) {
        await serializeFiles(value);
        const response = await fetch(`${backendUrl}/db/set`, {
          method: 'POST',
          mode: 'cors',
          headers: {
            ...getDefaultHeaders(),
            'Content-Type': 'application/json'
          },
          body: JSON.stringify([target.collection, property, value]) // body data type must match "Content-Type" header
        });
        if (response.status === 200) {
          target[property] = value;
          return true;
        } else {
          throw new Error(`Error setting ${target.collection} with ID ${property}`);
        }
      }
    });

    constructor(collection) {
      super();
      this.collection = collection;
      return this.proxy;
    }
  }

  return {
    auth,
    DatabaseArray,
    DatabaseMap
  }
}