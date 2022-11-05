import {outgoingReplacer, traverse, incomingReplacer, CustomStore} from "./utils";
import WebSocket from "isomorphic-ws";

type document = { id: string, [key: string]: any }
type fn = (v: any) => any

export function initApp(config: { serverUrl?: string, apiKey?: string, connector: 'HTTP' | 'LOCAL' | 'WS', opHandlers?: any } = {connector: 'HTTP'}) {
    config = {...{connector: 'HTTP'}, ...config}
    let baseUrl = '';
    let apiKey = '';
    let ws: undefined | WebSocket;
    let queue: string[] = [];
    const realtimeListeners: Map<string,CustomStore> = new Map();
    const cachedRealtimeValues = new Map();

    async function request(path = '', data = {}, method = 'POST'): Promise<any> {
        const response = await fetch(baseUrl+path, {
            method: method,
            mode: 'cors',
            headers: {
                'Content-Type': 'application/json',
                'Authorization' : auth.value.token?`Bearer ${auth.value.token}`:'',
                'X-API-Key' : apiKey
            },
            redirect: 'follow',
            referrerPolicy: 'no-referrer',
            body: JSON.stringify(await traverse(data, outgoingReplacer))
        });
        if(response.headers.get('Content-Length') === '2') {
            return {}
        }
        return await traverse(await response.json(), incomingReplacer);
    }

    function startWs() {
        try {
            if (ws) {
                ws.close();
            }

            ws = new WebSocket(baseUrl?.replace('http://', 'ws://').replace('https://', 'wss://'));

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

            ws.onmessage = async function incoming(event: any) {
                try {
                    const data = JSON.parse(event.data);
                    data.value = await traverse(data.value, incomingReplacer);
                    if (data.operation === 'get') {
                        cachedRealtimeValues.set(data.fullPath, data.value);
                        realtimeListeners.get(data.fullPath)?.set(data.value);
                    } else if (data.operation === 'filter') {
                        const key = data.eventName;
                        let value = cachedRealtimeValues.get(key) || [];
                        if (data.content === 'reset') {
                            value = data.value;
                        } else if (data.content === 'drop') {
                            value = []
                        }
                        cachedRealtimeValues.set(key, value);
                        realtimeListeners.get(key)?.set(value);
                    } else if (data.operation === 'push') {
                        realtimeListeners.get(data.eventName)?.set(data.value);
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
            let eventStore = realtimeListeners.get(eventName)
            if(!eventStore){
                eventStore = new CustomStore();
                realtimeListeners.set(eventName, eventStore);
            }
            const eventStoreUnsubscribe = eventStore.subscribe(documentChangeHandler)
            if (eventStore.subscriptions.size === 1) {
                const wsData = JSON.stringify({
                    operation, eventName, ...data,
                    authorization: `Bearer ${auth.value.token}`
                });
                if (ws?.readyState === WebSocket.OPEN) {
                    ws.send(wsData);
                } else {
                    queue.push(wsData);
                }
            }

            return function unsubscribe() {
                eventStoreUnsubscribe()
                if (eventStore?.subscriptions.size === 0) {
                    // TODO : send message to server to unsubscribe from this specific event.
                }
            }
        }
    }

    function setServerUrl(_baseUrl: string) {
        const oldBaseUrl = baseUrl;
        if (oldBaseUrl !== _baseUrl) {
            baseUrl = _baseUrl;
            startWs();
        }
    }

    function setApiKey(_apiKey: string) {
        apiKey = _apiKey;
    }

    const Auth = class Auth extends CustomStore {
        value: {token?: string, userId?: string}
        constructor() {
            super()
            this.value = {}
            if (typeof process !== 'object') {
                this.value = {token:localStorage.token, userId: localStorage.userId};
            }
        }

        signOut = () => {
            delete localStorage.token;
            delete localStorage.userId;
            this.set({})
        }

        signIn = async (credentials: { email: string, password: string }) => {
            try {
                const {token, userId} = await request('/auth/signin', {...credentials});
                this.set({token, userId})
                if (typeof process !== 'object') {
                    localStorage.token = this.value.token;
                    localStorage.userId = this.value.userId;
                }
                return true;
            } catch (e) {
                throw new Error(`Error logging in, verify email and password`);
            }
        }

        createAccount = async (credentials: { email: string, password: string }) => {
            try {
                const {token, userId} = await request('/auth/signup', credentials);
                this.set({token, userId})
                if (typeof process !== 'object') {
                    localStorage.token = this.value.token;
                    localStorage.userId = this.value.userId;
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
                    const result = await request('/db/length', {...data});
                    return result.value;
                })();
            },
            async map(data: { collection: string, callbackFn: fn | string, thisArg?: any }): Promise<Array<any>> {
                const result = await request('/db/map', data);
                return result;
            },
            async filter(data: { collection: string, operations: Array<any> }): Promise<any> {
                const result = await request('/db/filter', data);
                return result.value;
            },
            async slice(data: { collection: string, start: number, end?: number }): Promise<Array<document>> {
                const result = await request('/db/slice', data);
                return result;
            },
            async find(data: { collection: string, callbackFn: string, thisArg: any }): Promise<document> {
                const result = await request('/db/find', data);
                return result.value
            },
            async forEach(data: { collection: string }, callback: fn): Promise<unknown> {
                const result = await request('/db/forEach', data);
                return result.forEach(callback);
            },
            async push(data: { collection: string, value: any }): Promise<string> {
                const result = await request(
                    '/db/push',
                    data
                );
                return result.value;
            },
            delete(data: { collection: string, id: string | number | symbol, path?: Array<string> }): Promise<boolean> {
                return (async () => {
                    const result = await request('/db/delete', data);
                    return result.value;
                })();
            },
            set(data: { collection: string, id: string | number | symbol, value: any, path?: Array<any> }): Promise<boolean> {
                return (async () => {
                    try {
                        await request('/db/set', data);
                        return true;
                    } catch (e) {
                        return false;
                    }
                })();
            },
            async clear(data: { collection: string }): Promise<boolean> {
                await request('/db/clear', data);
                return true;
            },
            async get(data: { collection: string, id: string | number | symbol, path?: Array<any> }): Promise<document> {
                const result = await request('/db/get', data);
                return result.value;
            },
            async has(data: { collection: string, id: string | number | symbol }): Promise<boolean> {
                const result = await request('/db/has', data);
                return result.value;
            },
            async keys(data: { collection: string }): Promise<Array<string>> {
                const result = await request('/db/keys', data);
                return result;
            },
            async getAll(data: { collection: string }): Promise<Array<document>> {
                const result = await request('/db/getAll', data);
                return result;
            }
        },
        WS: {
            size(data: { collection: string }): Promise<number> {
                return (async () => {
                    const result = await request('/db/length', {...data});
                    return result.value;
                })();
            },
            async map(data: { collection: string, callbackFn: fn | string, thisArg?: any }): Promise<Array<any>> {
                const result = await request('/db/map', data);
                return result;
            },
            async filter(data: { collection: string, operations: Array<any> }): Promise<any> {
                const result = await request('/db/filter', data);
                return result.value;
            },
            async slice(data: { collection: string, start: number, end?: number }): Promise<Array<document>> {
                const result = await request('/db/slice', data);
                return result;
            },
            async find(data: { collection: string, callbackFn: string, thisArg: any }): Promise<document> {
                const result = await request('/db/find', data);
                return result.value
            },
            async forEach(data: { collection: string }, callback: fn): Promise<unknown> {
                const result = await request('/db/forEach', data);
                return result.forEach(callback);
            },
            async push(data: { collection: string, value: any }): Promise<string> {
                return new Promise((resolve, reject) => {
                    let timeout = setTimeout(() => {
                        reject(new Error('Push timed out.'));
                    },5000);
                    const unsubscribe = subscriptionFactory((Math.random()*10000).toString(), data, 'push')(id => {
                        resolve(id);
                        unsubscribe();
                        clearTimeout(timeout);
                    });
                })
            },
            delete(data: { collection: string, id: string | number | symbol, path?: Array<string> }): Promise<boolean> {
                return (async () => {
                    const result = await request('/db/delete', data);
                    return result.value;
                })();
            },
            set(data: { collection: string, id: string | number | symbol, value: any, path?: Array<any> }): Promise<boolean> {
                return (async () => {
                    try {
                        await request('/db/set', data);
                        return true;
                    } catch (e) {
                        return false;
                    }
                })();
            },
            async clear(data: { collection: string }): Promise<boolean> {
                await request('/db/clear', data);
                return true;
            },
            async get(data: { collection: string, id: string | number | symbol, path?: Array<any> }): Promise<document> {
                const result = await request('/db/get', data);
                return result.value;
            },
            async has(data: { collection: string, id: string | number | symbol }): Promise<boolean> {
                const result = await request('/db/has', data);
                return result.value;
            },
            async keys(data: { collection: string }): Promise<Array<string>> {
                const result = await request('/db/keys', data);
                return result;
            },
            async getAll(data: { collection: string }): Promise<Array<document>> {
                const result = await request('/db/getAll', data);
                return result;
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
            async clear(data: { collection: string }): Promise<boolean> {
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

    const DatabaseCollection = class DatabaseCollection {
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

        async clear(): Promise<boolean> {
            return connectors[config.connector].clear({collection: this.collection});
        }

        async set(key: string, value: any): Promise<DatabaseCollection> {
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

        async has(id: string): Promise<boolean> {
            return connectors[config.connector].has({collection: this.collection, id});
        }

        async delete(id: string): Promise<boolean> {
            return connectors[config.connector].delete({collection: this.collection, id});
        }

        async keys(): Promise<Array<string>> {
            return connectors[config.connector].keys({collection: this.collection})
        }

        // @ts-ignore
        get size() {
            return connectors[config.connector].size({collection: this.collection})
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

    const db = new Proxy({}, {
        get(_target, property) {
            return new DatabaseCollection(property.toString())
        }
    })

    const functions = new Proxy({}, {
        get(_target, property) {
            return async (data: any) => (await request(`/functions/${property.toString()}`, data));
        }
    })

    if (config.serverUrl || (typeof window !== "undefined" && config.connector !== 'LOCAL')) {
        setServerUrl(config?.serverUrl || window.location.origin);
    }

    if (config?.apiKey) {
        setApiKey(config?.apiKey);
    }

    return {functions, db, ChainableFilter, auth, setApiKey, setServerUrl}
}

const defaultApp = initApp({connector: 'HTTP'});
export const functions = defaultApp.functions;
export const db = defaultApp.db;
export const ChainableFilter = defaultApp.ChainableFilter;
export const auth = defaultApp.auth;
export const setApiKey = defaultApp.setApiKey;
export const setServerUrl = defaultApp.setServerUrl;
