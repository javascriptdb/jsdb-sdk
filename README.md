Install
```shell
npm i @jsdb/sdk
```

Import into your code
```js
import {functions, DatabaseArray, DatabaseMap, setServerUrl} from "@jsdb/sdk";
setServerUrl(SERVER_URL);
```

Save data
```js
const posts = new DatabaseArray('posts');
await posts.push({status: 'PUBLISHED', content: 'JSDB is awesome!', createdDate: new Date()});
```

Check the docs: https://javascriptdb.com/docs