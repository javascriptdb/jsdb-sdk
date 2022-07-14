import {parseData, serializeData} from "./utils";
import EventEmitter from "events";
import axios from 'axios';
import _ from 'lodash-es';
import WebSocket from "isomorphic-ws";

type document = { id: string, [key: string]: any }
type fn = (v: any) => any

export function initApp(config: { serverUrl?: string, apiKey?: string, connector: 'HTTP' | 'LOCAL' | 'WS', opHandlers?: any } = {connector: 'HTTP'}) {
    config = {...{connector: 'HTTP'}, ...config}
    const jsdbAxios = axios.create({
        baseURL: ''
    });
    let ws: undefined | WebSocket;
    let queue: string[] = [];
    const realtimeListeners = new EventEmitter();
    const cachedRealtimeValues = new Map();

    function startWs() {
        try {
            if (ws) {
                ws.close();
            }

            ws = new WebSocket(jsdbAxios.defaults.baseURL?.replace('http://', 'ws://').replace('https://', 'wss://'));

            ws.onopen = function open() {
                setTimeout(() => {
                    if (queue.length > 0) {
                        queue.forEach((wsData) => ws.send(wsData));
                        queue = [];
                    }
                },100)
            };

            ws.onclose = function close() {
                console.log('disconnected');
            };

            ws.onmessage = function incoming(event: any) {
                try {
                    const data = JSON.parse(event.data);
                    if (data.operation === 'get') {
                        cachedRealtimeValues.set(data.fullPath, data.value);
                        realtimeListeners.emit(data.fullPath, data.value);
                    } else if (data.operation === 'filter') {
                        const key = data.eventName;
                        let value = cachedRealtimeValues.get(key) || [];
                        if (data.content === 'reset') {
                            value = data.value;
                        } else if (data.content === 'add') {
                            value.push(data.value);
                        } else if (data.content === 'edit') {
                            const editedIndex = value.findIndex((o: any) => o._id === data.value._id);
                            value[editedIndex] = data.value;
                        } else if (data.content === 'delete') {
                            const deletedIndex = value.findIndex((o: any) => o._id === data.value._id);
                            value.splice(deletedIndex, 1);
                        } else if (data.content === 'drop') {
                            value = []
                        }
                        cachedRealtimeValues.set(key, value);
                        realtimeListeners.emit(key, value);
                    } else if (data.operation === 'push') {
                        realtimeListeners.emit(data.eventName, data.value);
                    }
                } catch (e) {
                    console.error(e);
                }
            };
        } catch (e) {
            console.error(e);
        }
    }

    function subscriptionFactory(eventName: string, data: any, operation: string) {
        return function subscribe(callbackFn: (arg0: any) => void) {
            function documentChangeHandler(documentData: any) {
                callbackFn(documentData);
            }

            realtimeListeners.on(eventName, documentChangeHandler)

            if (realtimeListeners.listenerCount(eventName) > 1 && cachedRealtimeValues.has(eventName)) {
                documentChangeHandler(cachedRealtimeValues.get(eventName))
            } else {
                const wsData = JSON.stringify({
                    operation, eventName, ...data,
                    authorization: jsdbAxios.defaults.headers.common['Authorization']
                });
                if (ws?.readyState === WebSocket.OPEN) {
                    ws.send(wsData);
                } else {
                    queue.push(wsData);
                }
            }

            return function unsubscribe() {
                realtimeListeners.off(eventName, documentChangeHandler);
                if (realtimeListeners.listenerCount(eventName) === 0) {
                    // TODO : send message to unsubscribe from this specific event.
                }
            }
        }
    }

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

    function setServerUrl(baseUrl: string) {
        const oldBaseUrl = jsdbAxios.defaults.baseURL;
        if (oldBaseUrl !== baseUrl) {
            jsdbAxios.defaults.baseURL = baseUrl;
            startWs();
        }
    }

    function setApiKey(apiKey: string) {
        jsdbAxios.defaults.headers.common['X-API-Key'] = apiKey;
    }

    const Auth = class Auth extends EventEmitter {
        token: undefined | string;
        userId: undefined | string;

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

        signIn = async (credentials: { email: string, password: string }) => {
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

        createAccount = async (credentials: { email: string, password: string }) => {
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

    const auth = new Auth();

    const connectors = {
        HTTP: {
            size(data: { collection: string }): Promise<number> {
                return (async () => {
                    const result = await jsdbAxios.post('/db/length', {...data});
                    return result.data.value;
                })();
            },
            async map(data: { collection: string, callbackFn: fn | string, thisArg?: any }): Promise<Array<any>> {
                const result = await jsdbAxios.post('/db/map', data);
                return result.data;
            },
            async filter(data: { collection: string, operations: Array<any> }): Promise<any> {
                const result = await jsdbAxios.post('/db/filter', data);
                return result.data.value;
            },
            async slice(data: { collection: string, start: number, end?: number }): Promise<Array<document>> {
                const result = await jsdbAxios.post('/db/slice', data);
                return result.data;
            },
            async find(data: { collection: string, callbackFn: string, thisArg: any }): Promise<document> {
                const result = await jsdbAxios.post('/db/find', data);
                return result.data.value
            },
            async forEach(data: { collection: string }, callback: fn): Promise<unknown> {
                const result = await jsdbAxios.post('/db/forEach', data);
                return result.data.forEach(callback);
            },
            async push(data: { collection: string, value: any }): Promise<string> {
                const result = await jsdbAxios.post(
                    '/db/push',
                    data
                );
                return result.data.value;
            },
            delete(data: { collection: string, id: string | number | symbol, path?: Array<string> }): Promise<boolean> {
                return (async () => {
                    const result = await jsdbAxios.post('/db/delete', data);
                    return result.data.value;
                })();
            },
            set(data: { collection: string, id: string | number | symbol, value: any, path?: Array<any> }): Promise<boolean> {
                return (async () => {
                    try {
                        await jsdbAxios.post('/db/set', data);
                        return true;
                    } catch (e) {
                        return false;
                    }
                })();
            },
            async clear(data: { collection: string }): Promise<number> {
                const result = await jsdbAxios.post('/db/clear', data);
                return result.data.value;
            },
            async get(data: { collection: string, id: string | number | symbol, path?: Array<any> }): Promise<document> {
                const result = await jsdbAxios.post('/db/get', data);
                return result.data.value;
            },
            async has(data: { collection: string, id: string | number | symbol }): Promise<boolean> {
                const result = await jsdbAxios.post('/db/has', data);
                return result.data.value;
            },
            async keys(data: { collection: string }): Promise<Array<string>> {
                const result = await jsdbAxios.post('/db/keys', data);
                return result.data;
            },
            async getAll(data: { collection: string }): Promise<Array<document>> {
                const result = await jsdbAxios.post('/db/getAll', data);
                return result.data;
            }
        },
        WS: {
            size(data: { collection: string }): Promise<number> {
                return (async () => {
                    const result = await jsdbAxios.post('/db/length', {...data});
                    return result.data.value;
                })();
            },
            async map(data: { collection: string, callbackFn: fn | string, thisArg?: any }): Promise<Array<any>> {
                const result = await jsdbAxios.post('/db/map', data);
                return result.data;
            },
            async filter(data: { collection: string, operations: Array<any> }): Promise<any> {
                const result = await jsdbAxios.post('/db/filter', data);
                return result.data.value;
            },
            async slice(data: { collection: string, start: number, end?: number }): Promise<Array<document>> {
                const result = await jsdbAxios.post('/db/slice', data);
                return result.data;
            },
            async find(data: { collection: string, callbackFn: string, thisArg: any }): Promise<document> {
                const result = await jsdbAxios.post('/db/find', data);
                return result.data.value
            },
            async forEach(data: { collection: string }, callback: fn): Promise<unknown> {
                const result = await jsdbAxios.post('/db/forEach', data);
                return result.data.forEach(callback);
            },
            async push(data: { collection: string, value: any }): Promise<string> {
                return new Promise((resolve) => {
                    // TODO : handle reject
                    const unsubscribe = subscriptionFactory((Math.random()*10000).toString(), data, 'push')(id => {
                        resolve(id);
                        unsubscribe();
                    });
                })
            },
            delete(data: { collection: string, id: string | number | symbol, path?: Array<string> }): Promise<boolean> {
                return (async () => {
                    const result = await jsdbAxios.post('/db/delete', data);
                    return result.data.value;
                })();
            },
            set(data: { collection: string, id: string | number | symbol, value: any, path?: Array<any> }): Promise<boolean> {
                return (async () => {
                    try {
                        await jsdbAxios.post('/db/set', data);
                        return true;
                    } catch (e) {
                        return false;
                    }
                })();
            },
            async clear(data: { collection: string }): Promise<number> {
                const result = await jsdbAxios.post('/db/clear', data);
                return result.data.value;
            },
            async get(data: { collection: string, id: string | number | symbol, path?: Array<any> }): Promise<document> {
                const result = await jsdbAxios.post('/db/get', data);
                return result.data.value;
            },
            async has(data: { collection: string, id: string | number | symbol }): Promise<boolean> {
                const result = await jsdbAxios.post('/db/has', data);
                return result.data.value;
            },
            async keys(data: { collection: string }): Promise<Array<string>> {
                const result = await jsdbAxios.post('/db/keys', data);
                return result.data;
            },
            async getAll(data: { collection: string }): Promise<Array<document>> {
                const result = await jsdbAxios.post('/db/getAll', data);
                return result.data;
            }
        },
        LOCAL: {
            size(data: { collection: string }): Promise<number> {
                return (async () => {
                    return config.opHandlers.size({collection: data.collection});
                })();
            },
            async map(data: { collection: string, callbackFn: string, thisArg?: any }): Promise<Array<any>> {
                return config.opHandlers.map(data);
            },
            async filter(data: { collection: string, operations: Array<any> }): Promise<any> {
                return config.opHandlers.filter(data);
            },
            async slice(data: { collection: string, start: number, end?: number }): Promise<Array<document>> {
                return config.opHandlers.slice(data);
            },
            async find(data: { collection: string, callbackFn: string, thisArg: any }): Promise<document> {
                return config.opHandlers.find(data);
            },
            async forEach(data: { collection: string }, callback: fn): Promise<unknown> {
                return config.opHandlers.getAll(data).forEach(callback);
            },
            async push(data: { collection: string, value: any }): Promise<string> {
                const result = config.opHandlers.set(data);
                return result.insertedId;
            },
            delete(data: { collection: string, id: string | number | symbol, path?: Array<string> }): Promise<boolean> {
                return (async () => {
                    return config.opHandlers.delete(data);
                })();
            },
            set(data: { collection: string, id: string | number | symbol, value: any, path?: Array<any> }): Promise<boolean> {
                return (async () => {
                    return config.opHandlers.set(data);
                })();
            },
            async clear(data: { collection: string }): Promise<number> {
                return config.opHandlers.clear(data);
            },
            async get(data: { collection: string, id: string | number | symbol, path?: Array<any> }): Promise<document> {
                return config.opHandlers.get(data);
            },
            async has(data: { collection: string, id: string | number | symbol }): Promise<boolean> {
                return config.opHandlers.has(data);
            },
            async keys(data: { collection: string }): Promise<Array<string>> {
                return config.opHandlers.keys(data);
            },
            async getAll(data: { collection: string }): Promise<Array<document>> {
                return config.opHandlers.getAll(data);
            }
        },
    }

    // @ts-ignore
    function nestedProxyFactory(path: string[]) {
        let resolve: { (arg0: any): void; (value?: unknown): void; };
        let reject: (reason?: any) => void;

        const proxyPromise = new Promise((_resolve, _reject) => {
            resolve = _resolve;
            reject = _reject;
        });

        return new Proxy(proxyPromise, {
            get(target, property) {
                if (property === '__fullPath') {
                    return path.join('.')
                } else if (property === 'then') {
                    const data = {collection: path[0], id: path[1], path: path.slice(2)};
                    connectors[config.connector].get(data).then(result => {
                        resolve(result);
                    }).catch(reject);
                    return target[property].bind(proxyPromise);
                }
                if (property === 'subscribe') {
                    return subscriptionFactory(path.join('.'), {
                        collection: path[0],
                        id: path[1],
                        path: path.slice(2)
                    }, 'get');
                } else {
                    return nestedProxyFactory([...path, property.toString()]);
                }
            },
            // @ts-ignore
            set(target, property, value) {
                const newPath = [...path, property]
                const data = {collection: newPath[0].toString(), id: newPath[1], path: newPath.slice(2), value};
                return connectors[config.connector].set(data);
            },
            // @ts-ignore
            deleteProperty(target, property) {
                const newPath = [...path, property]
                const data = {collection: newPath[0].toString(), id: newPath[1], path: <Array<string>>newPath.slice(2)};
                return connectors[config.connector].delete(data);
            }
        })
    }

    const DatabaseMap = class DatabaseMap {
        collection: string;


        proxy = new Proxy(this, {
            // @ts-ignore
            set(target, property, value) {
                return connectors[config.connector].set({collection: target.collection, id: property, value})
            },
            get(target, property, receiver) {
                return Reflect.get(target, property, receiver) || nestedProxyFactory([target.collection, property.toString()]);
            },
            // @ts-ignore
            deleteProperty(target, property) {
                return connectors[config.connector].delete({collection: target.collection, id: property})
            }
        });

        async clear(): Promise<number> {
            return connectors[config.connector].clear({collection: this.collection});
        }

        async set(key: string, value: any): Promise<DatabaseMap> {
            await connectors[config.connector].set({collection: this.collection, id: key, value})
            return this;
        }

        async get(key: string): Promise<document> {
            return connectors[config.connector].get({collection: this.collection, id: key})
        }

        async entries() {
            const resultMap = new Map();
            await connectors[config.connector].forEach({collection: this.collection}, (element: document) => {
                resultMap.set(element.id, element);
            })
            return resultMap.entries();
        }

        async values() {
            const resultMap = new Map();
            await connectors[config.connector].forEach({collection: this.collection}, (element: document) => {
                resultMap.set(element.id, element);
            })
            return resultMap.values();
        }

        async forEach(callback: fn): Promise<unknown> {
            return connectors[config.connector].forEach({collection: this.collection}, callback)
        }

        async has(id: string): Promise<boolean> {
            return connectors[config.connector].has({collection: this.collection, id});
        }

        async delete(id: string): Promise<boolean> {
            return connectors[config.connector].delete({collection: this.collection, id});
        }

        // @ts-ignore
        get size() {
            return connectors[config.connector].size({collection: this.collection})
        }

        async keys(): Promise<Array<string>> {
            return connectors[config.connector].keys({collection: this.collection})
        }

        async* [Symbol.asyncIterator]() {
            const result = await connectors[config.connector].getAll({collection: this.collection})
            yield* result;
        }

        constructor(collection: string) {
            this.collection = collection;
            return this.proxy;
        }
    }

    type operation = {
        type: string,
        data?: any
    }

    const ChainableFilter = class ChainableFilter {
        operations: operation[]
        collection: string

        constructor(collection: string, operations: operation[]) {
            this.operations = operations;
            this.collection = collection;
        }

        // @ts-ignore
        get length() {
            this.operations.push({
                type: 'length'
            });
            return this;
        }

        map(callbackFn: fn, thisArg = {}) {
            const data = {
                callbackFn: callbackFn.toString(),
                thisArg
            };
            this.operations.push({
                type: 'map',
                data,
            });
            return this;
        }

        filter(callbackFn: fn, thisArg = {}) {
            const data = {
                callbackFn: callbackFn
                    .toString(),
                thisArg
            }

            this.operations.push({
                type: 'filter',
                data,
            });
            return this;
        }

        slice(start = 0, end?: number) {
            const data = {
                start,
                end
            };
            this.operations.push({
                type: 'slice',
                data,
            });
            return this;
        }

        orderBy(property: string, order: 'ASC' | 'DESC' = 'ASC') {
            const data = {
                property,
                order
            }
            this.operations.push({
                type: 'orderBy',
                data,
            });
            return this;
        }

        async then(successFn: fn, errorFn: fn): Promise<any> {
            try {
                const result = await connectors[config.connector].filter({
                    collection: this.collection,
                    operations: this.operations
                });
                successFn(result);
            } catch (e) {
                errorFn(e)
            }
        }

        // @ts-ignore
        get subscribe() {
            let eventName = this.collection + JSON.stringify(this.operations);
            return subscriptionFactory(eventName, {
                collection: this.collection,
                operations: this.operations
            }, 'filter');
        }
    }

    const DatabaseArray = class DatabaseArray {
        collection: string;

        async* [Symbol.asyncIterator]() {
            const result = await connectors[config.connector].getAll({collection: this.collection})
            yield* result;
        }

        // @ts-ignore
        get size(): Promise<number> {
            return connectors[config.connector].size({collection: this.collection});
        }

        async map(callbackFn: fn, thisArg = {}): Promise<Array<any>> {
            return connectors[config.connector].map({
                collection: this.collection,
                callbackFn: callbackFn.toString(),
                thisArg
            })
        }

        filter(callbackFn: fn, thisArg = {}) {
            const data = {
                callbackFn: callbackFn
                    .toString(),
                thisArg
            }
            return new ChainableFilter(this.collection, [{type: 'filter', data}]);
        }

        async slice(start = 0, end?: number): Promise<Array<document>> {
            return connectors[config.connector].slice({
                collection: this.collection,
                start,
                end
            });
        }

        async find(callbackFn: fn, thisArg = {}): Promise<document> {
            return connectors[config.connector].find({
                collection: this.collection,
                callbackFn: callbackFn
                    .toString(),
                thisArg
            });
        }

        async forEach(callback: fn): Promise<unknown> {
            return connectors[config.connector].forEach({collection: this.collection}, callback);
        }

        async push(value: any): Promise<string> {
            return connectors[config.connector].push({collection: this.collection, value});
        }

        proxy = new Proxy(this, {
            // @ts-ignore
            set: function (target, property, value) {
                return connectors[config.connector].set({collection: target.collection, id: property, value})
            },
            get(target, property, receiver) {
                if (property === 'length') property = 'size';
                return Reflect.get(target, property, receiver) || nestedProxyFactory([target.collection, property.toString()]);
            },
            // @ts-ignore
            deleteProperty(target, property) {
                return connectors[config.connector].delete({collection: target.collection, id: property})
            }
        });

        constructor(collection: string) {
            this.collection = collection;
            return this.proxy;
        }
    }

    const functions = new Proxy({}, {
        get(_target, property) {
            return async (data: any) => (await jsdbAxios.post(`/functions/${property.toString()}`, data)).data;
        }
    })

    if (config.serverUrl || (typeof window !== "undefined" && config.connector !== 'LOCAL')) {
        setServerUrl(config?.serverUrl || window.location.origin);
    }

    if (config?.apiKey) {
        setApiKey(config?.apiKey);
    }

    return {functions, DatabaseArray, ChainableFilter, DatabaseMap, auth, setApiKey, setServerUrl}
}

const defaultApp = initApp({connector: 'HTTP'});
export const functions = defaultApp.functions;
export const DatabaseArray = defaultApp.DatabaseArray;
export const ChainableFilter = defaultApp.ChainableFilter;
export const DatabaseMap = defaultApp.DatabaseMap;
export const auth = defaultApp.auth;
export const setApiKey = defaultApp.setApiKey;
export const setServerUrl = defaultApp.setServerUrl;
