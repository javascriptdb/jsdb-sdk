import {parseData, serializeData} from "./utils.js";
import EventEmitter from "events";
import axios from 'axios';
import _ from 'lodash-es';
import WebSocket from "isomorphic-ws";

const realtimeListeners = new EventEmitter();
const cachedRealtimeValues = new Map();
const ws = new WebSocket('ws://localhost:3001/');
const queue = [];
ws.onopen = function open() {
    if (queue.length > 0) {
        queue.forEach((wsData) => ws.send(wsData));
    }
};

ws.onclose = function close() {
    console.log('disconnected');
};

ws.onmessage = function incoming(event) {
    try {
        const data = JSON.parse(event.data);
        if (data.operation === 'documentChange') {
            cachedRealtimeValues.set(data.fullPath, data.value);
            realtimeListeners.emit(data.fullPath, data.value);
        }
    } catch (e) {
        console.error(e);
    }
};

const jsdbAxios = axios.create({
    baseURL: 'http://localhost:3001/',
});

jsdbAxios.defaults.headers.common['Content-Type'] = 'application/json';

jsdbAxios.interceptors.request.use(async function (config) {
    if (Array.isArray(config.data)) {
        await config.data.map(async element => await serializeData(element));
    } else if (_.isPlainObject(config.data)) {
        await serializeData(config.data);
    }
    return config;
}, function (error) {
    return Promise.reject(error);
});

jsdbAxios.interceptors.response.use(async function (response) {
    if (Array.isArray(response.data)) {
        await response.data.map(async element => await parseData(element));
    } else if (_.isPlainObject(response.data)) {
        await parseData(response.data);
    }
    return response;
}, function (error) {
    return Promise.reject(error);
});

export function setServerUrl(baseUrl) {
    jsdbAxios.defaults.baseURL = baseUrl;
}

export function setApiKey(apiKey) {
    jsdbAxios.defaults.headers.common['X-API-Key'] = apiKey;
}

class Auth extends EventEmitter {
    token;
    userId;

    constructor() {
        super()
        if (typeof process !== 'object') {
            this.token = localStorage.token;
            this.userId = localStorage.userId;
            if (this.token) jsdbAxios.defaults.headers.common['Authorization'] = `Bearer ${localStorage.token}`;
        }
        this.on('newListener', (event, listener) => {
            if (event === 'tokenChanged') {
                listener(this.token);
            }
        })
    }

    signOut = () => {
        delete localStorage.token;
        delete localStorage.userId;
        delete jsdbAxios.defaults.headers.common['Authorization'];
        this.emit('tokenChanged', undefined);
    }

    signIn = async (credentials) => {
        try {
            const {data: {token, userId}} = await jsdbAxios.post('/auth/signin', {...credentials});
            this.token = token;
            this.userId = userId;
            jsdbAxios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
            this.emit('tokenChanged', this.token);
            if (typeof process !== 'object') {
                localStorage.token = this.token;
                localStorage.userId = this.userId;
            }
            return true;
        } catch (e) {
            throw new Error(`Error logging in, verify email and password`);
        }
    }

    createAccount = async (credentials) => {
        try {
            const {data: {token, userId}} = await jsdbAxios.post('/auth/signup', {...credentials});
            this.token = token;
            this.userId = userId;
            jsdbAxios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
            this.emit('tokenChanged', this.token);
            if (typeof process !== 'object') {
                localStorage.token = this.token;
                localStorage.userId = this.userId;
            }
            return true;
        } catch (e) {
            throw new Error(`Error logging in, verify email and password`);
        }
    }
}

export const auth = new Auth();

function nestedProxyFactory(path) {
    let resolve;
    let reject;

    const proxyPromise = new Promise((_resolve, _reject) => {
        resolve = _resolve;
        reject = _reject;
    });

    return new Proxy(proxyPromise, {
        get(target, property, receiver) {
            if(property === '__fullPath') {
                return path.join('.')
            } else if (property === 'then') {
                const data = {collection: path[0], id: path[1], path: path.slice(2)};
                jsdbAxios.post('/db/get', data).then(result => {
                    resolve(result.data.value);
                }).catch(reject);
                return target[property].bind(proxyPromise);
            }
            if (property === 'subscribe') {
                const data = {collection: path[0], id: path[1], path: path.slice(2)};
                return function subscribe(callbackFn) {
                    function documentChangeHandler(documentData) {
                        callbackFn(documentData);
                    }

                    const eventName = path.join('.');
                    realtimeListeners.on(eventName, documentChangeHandler)

                    if(realtimeListeners.listenerCount(eventName) > 0 && cachedRealtimeValues.has(eventName)) {
                        documentChangeHandler(cachedRealtimeValues.get(eventName))
                    } else {
                        const wsData = JSON.stringify({
                            operation: 'get', ...data,
                            authorization: jsdbAxios.defaults.headers.common['Authorization']
                        });
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(wsData);
                        } else {
                            queue.push(wsData)
                        }
                    }


                    return function unsubscribe() {
                        realtimeListeners.off(eventName, documentChangeHandler);
                    }
                }
            } else {
                return nestedProxyFactory([...path, property]);
            }
        },
        set(target, property, value) {
            const newPath = [...path, property]
            const data = {collection: newPath[0], id: newPath[1], path: newPath.slice(2), value};
            return (async () => {
                try {
                    const result = await jsdbAxios.post('/db/set', data);
                    resolve(result.data);
                    return true;
                } catch (e) {
                    reject(e)
                    return false;
                }
            })();
        },
        deleteProperty(target, property) {
            const newPath = [...path, property]
            const data = {collection: newPath[0], id: newPath[1], path: newPath.slice(2)};
            return (async () => {
                try {
                    const result = await jsdbAxios.post('/db/delete', data);
                    resolve(result.data);
                    return true;
                } catch (e) {
                    reject(e)
                    return false;
                }
            })();
        }
    })
}

export class DatabaseMap extends Map {
    collection;

    proxy = new Proxy(this, {
        set(target, property, value) {
            const data = {collection: target.collection, id: property, value};
            return (async () => {
                try {
                    await jsdbAxios.post('/db/set', data);
                    return true;
                } catch (e) {
                    return false;
                }
            })();
        },
        get(target, property, receiver) {
            return Reflect.get(target, property, receiver) || nestedProxyFactory([target.collection, property]);
        },
        deleteProperty(target, property) {
            return (async () => {
                const result = await jsdbAxios.post('/db/delete', {collection: target.collection, id: property});
                return result.data.value;
            })();
        }
    });

    async clear() {
        const result = await jsdbAxios.post('/db/clear', {collection: this.collection});
        return result.data.value;
    }

    async set(key, value) {
        const result = await jsdbAxios.post('/db/set', {collection: this.collection, id: key, value});
        return this;
    }

    async get(key) {
        const result = await jsdbAxios.post('/db/get', {collection: this.collection, id: key});
        return result.data;
    }

    async entries() {
        const result = await jsdbAxios.post('/db/entries', {collection: this.collection});
        const resultMap = new Map();
        result.data.forEach(element => {
            resultMap.set(element._id, element);
        });
        return resultMap.entries();
    }

    async values() {
        const result = await jsdbAxios.post('/db/values', {collection: this.collection});
        const resultMap = new Map();
        result.data.forEach(element => {
            resultMap.set(element._id, element);
        });
        return resultMap.values();
    }

    async forEach(callbackFn) {
        const result = await jsdbAxios.post('/db/forEach', {collection: this.collection});
        return result.data.forEach(callbackFn);
    }

    async has(key) {
        const result = await jsdbAxios.post('/db/has', {collection: this.collection, id: key});
        return result.data.value;
    }

    async delete(key) {
        const result = await jsdbAxios.post('/db/delete', {collection: this.collection, id: key});
        return result.data.value;
    }

    get size() {
        return (async () => {
            const result = await jsdbAxios.post('/db/size', {collection: this.collection});
            return result.data.value;
        })();
    }

    async keys() {
        const result = await jsdbAxios.post('/db/keys', {collection: this.collection});
        return result.data;
    }

    async* [Symbol.asyncIterator]() {
        const result = await jsdbAxios.post('/db/getAll', {collection: this.collection});
        yield* result.data
    }

    constructor(collection) {
        super();
        this.collection = collection;
        return this.proxy;
    }
}

export class DatabaseArray extends Array {
    collection;

    async* [Symbol.asyncIterator]() {
        const result = await jsdbAxios.post('/db/getAll', {collection: this.collection});
        yield* result.data
    }

    get size() {
        return (async () => {
            const result = await jsdbAxios.post('/db/length', {collection: this.collection});
            return result.data.value;
        })();
    }

    get length() {
        return (async () => {
            const result = await jsdbAxios.post('/db/length', {collection: this.collection});
            return result.data.value;
        })();
    }

    async map(callbackFn, thisArg = {}) {
        const result = await jsdbAxios.post('/db/map', {
            collection: this.collection,
            callbackFn: callbackFn.toString(),
            thisArg
        });
        return result.data;
    }

    async filter(callbackFn, thisArg = {}) {
        const result = await jsdbAxios.post('/db/filter', {
            collection: this.collection,
            callbackFn: callbackFn
                .toString(),
            thisArg
        });
        return result.data;
    }

    async find(callbackFn, thisArg = {}) {
        const result = await jsdbAxios.post('/db/find', {
            collection: this.collection,
            callbackFn: callbackFn
                .toString(),
            thisArg
        });
        return result.data.value
    }

    async forEach(callback) {
        const result = await jsdbAxios.post(
            '/db/getAll',
            {collection: this.collection}
        );
        return result.data.forEach(callback);
    }

    async push(value) {
        const result = await jsdbAxios.post(
            '/db/push',
            {collection: this.collection, value}
        );
        return result.data.value;
    }

    proxy = new Proxy(this, {
        set: function (target, property, value, receiver) {
            const data = {collection: target.collection, id: property, value};
            return (async () => {
                try {
                    await jsdbAxios.post('/db/set', data);
                    return true;
                } catch (e) {
                    return false;
                }
            })();
        },
        get(target, property, receiver) {
            if (property === 'length') property = 'size';
            return Reflect.get(target, property, receiver) || nestedProxyFactory([target.collection, property]);
        },
        deleteProperty(target, property) {

            return (async () => {
                const result = await jsdbAxios.post('/db/delete', {collection: target.collection, id: property});
                return result.data.value;
            })();
        }
    });

    constructor(collection, ...args) {
        super(...args);
        this.collection = collection;
        return this.proxy;
    }
}

export const functions = new Proxy({}, {
    get(target, property, receiver) {
        return async data => (await jsdbAxios.post(`/functions/${property}`, data)).data;
    }
})
